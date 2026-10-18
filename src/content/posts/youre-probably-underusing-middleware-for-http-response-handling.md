---
title: "You're probably underusing middleware for HTTP response handling"
pubDatetime: 2026-05-17T21:08:32Z
modDatetime: 2026-05-25T22:51:03Z
description: "Deciding what counts as a successful response in a `handle_response/1` after `Tesla.get`, instead of inside the Tesla middleware chain, makes 5xx and malformed payloads look like successful requests to your telemetry."
tags:
  - "elixir"
  - "tesla"
  - "api"
  - "observability"
---

When you wrap an external API in Elixir, most of what a function like `Acme.fetch_user/1` does is response handling: validate the status, parse the body, translate failures. That code almost always lives after the `Tesla.get` call, in a `case` or a `handle_response/1` at the end of a `|>` pipeline.

That's the wrong place. A middleware can return `{:error, ...}` from `Tesla.run`, which makes Tesla's telemetry event record the request as failed. A function called after `Tesla.get` can't do that. It only sees the result. Failures it detects don't reach telemetry, so your observability stack undercounts them.

> Code samples use Tesla. Same shapes apply to Req. Pick whichever you're using and translate as you go.

## Real APIs don't read their own docs

Real APIs are dirtier than tutorial examples. A few I've run into:

- I've seen well-known, large providers respond with bodies that fail to parse. Yup, broken JSON
- A field documented as a `boolean` returns the JSON string `"true"` for true and, the JSON string `"No"` for false.
- A field documented as a string returns `"N/A"`, or just `""`, to mean NULL.

Your API client translates external bytes into something your application can rely on, and that parsing can fail. Malformed JSON already makes Tesla return `{:error, ...}`. A malformed *value* inside a well-formed JSON is the same failure, one layer up.


## The pattern that fails

Here is a `fetch_user/1` written in a pattern I see a lot. `handle_response/1` is a shared helper: every endpoint in the module funnels through it. `fetch_user`, `create_user`, `delete_invoice` all end with `|> handle_response()`: one place for the wrap, one place for error translation. Here is just one endpoint to keep the example small.

```elixir
def fetch_user(id) do
  case client() |> Tesla.get("/users/#{id}") |> handle_response() do
    {:ok, body} -> {:ok, decode_user(body)}
    {:error, :not_found} -> {:error, :not_found}
    _ -> {:error, :service_unavailable}
  end
end

defp handle_response({:ok, %Tesla.Env{status: status, body: body}})
     when status in 200..299 do
  {:ok, body}
end

defp handle_response({:ok, %Tesla.Env{status: 404}}) do
  {:error, :not_found}
end

defp handle_response({:ok, %Tesla.Env{status: status, body: body}}) do
  Logger.error("Acme API returned unexpected status #{status}: #{inspect(body)}")
  {:error, {:unexpected_status, status, body}}
end

defp handle_response(result), do: result

defp decode_user(body) do
  {:ok, created_at, _} = DateTime.from_iso8601(body["created_at"])

  %{
    id: body["id"],
    first_name: body["first_name"],
    last_name: body["last_name"],
    email: body["email"],
    created_at: created_at
  }
end
```

When the API returns a `500`, `handle_response/1` produces `{:error, {:unexpected_status, 500, body}}`, the `case` falls through to `_ -> {:error, :service_unavailable}`, and the caller gets a clean tagged tuple. The function itself is doing nothing wrong.

Tesla considers the request successful. The middleware chain returned `{:ok, env}`. The standard `[:tesla, :request, :stop]` telemetry event records it as `:ok`. `Tesla.Middleware.Retry`, whose default `should_retry` matches `{:error, _}`, sees `{:ok, env}` and doesn't fire. The `500` only becomes an "error" inside `handle_response/1`'s return value and the surrounding `case`. That's application code, after the request is done.

The `Logger.error` inside `handle_response/1` is a patch for this. Telemetry doesn't catch the 5xx, so someone adds a log line by hand. The error reaches the logs but skips the telemetry pipeline, and every API client module grows its own version.

Body parsing has the same hole. `decode_user/1` returns the user map directly and can't signal a parse error. If the API renames `email` to `email_address`, `body["email"]` is `nil` and the caller gets a user with `nil` in the email field. If `body["created_at"]` is missing or malformed, `DateTime.from_iso8601/1` returns `{:error, _}` and the `{:ok, created_at, _} = ...` match raises a `MatchError`. Phoenix or Oban catches the exception, but Tesla still considers the request successful and the telemetry event still says `:ok`.

## Middleware can fail the request

When a middleware returns `{:error, ...}` from `Tesla.run`, the request short-circuits. The Telemetry middleware emits `[:tesla, :request, :stop]` with `error: reason` in the metadata, and `Tesla.get` returns `{:error, ...}` (or `Tesla.get!` raises a `Tesla.Error`). A `handle_response/1` chained after the call only sees the result, so any failure it spots stays out of telemetry.

A `404` from `fetch_user/1` means the user doesn't exist, return `{:error, :not_found}`. A `404` from `POST /users` means the route isn't there, which is a bug to crash on. Same status, different meaning. The middleware can't decide globally what counts as "ok"; the caller has to declare it.

## Doing it in middleware

The middleware takes a per-call map of expected statuses and how to parse their bodies. Here's `fetch_user/1` using it:

```elixir
def fetch_user(id) do
  case Tesla.get(client(), "/users/#{id}",
         opts: [
           parse_body: %{
             200 => &decode_user/1,
             404 => fn _ -> {:ok, nil} end
           }
         ]) do
    {:ok, %Tesla.Env{status: 200, body: user}} -> {:ok, user}
    {:ok, %Tesla.Env{status: 404}} -> {:error, :not_found}
    {:error, _} -> {:error, :service_unavailable}
  end
end

defp decode_user(body) do
  with :ok <- check_required(body, ["id", "first_name", "last_name", "email", "created_at"]),
       {:ok, created_at, _} <- DateTime.from_iso8601(body["created_at"]) do
    {:ok,
     %{
       id: body["id"],
       first_name: body["first_name"],
       last_name: body["last_name"],
       email: body["email"],
       created_at: created_at
     }}
  end
end

defp check_required(body, fields) do
  case Enum.filter(fields, &is_nil(Map.get(body, &1))) do
    [] -> :ok
    missing -> {:error, {:missing_fields, missing}}
  end
end
```

The middleware behind `parse_body`:

```elixir
defmodule ParseBody do
  @behaviour Tesla.Middleware

  @impl true
  def call(env, next, _opts) do
    with {:ok, env} <- Tesla.run(env, next) do
      parsers = Keyword.fetch!(env.opts, :parse_body)

      case Map.fetch(parsers, env.status) do
        :error ->
          {:error,
           {:unexpected_status,
            status: env.status, expected: Map.keys(parsers), body: env.body}}

        {:ok, parser} ->
          case parser.(env.body) do
            {:ok, parsed} ->
              {:ok, %{env | body: parsed}}

            {:error, reason} ->
              {:error,
               {:parse_error, status: env.status, reason: reason, body: env.body}}
          end
      end
    end
  end
end
```

Parser failures short-circuit `with` and become failed Tesla requests, not a separate validation step the caller has to remember. They fire the same `[:tesla, :request, :stop]` event as any other failure, with the error in metadata.

The `handle_response/1` helper is gone. The `when status in 200..299` guard is gone. The `Logger.error` is gone too. Telemetry handles the logging now.

`{:error, _}` in `fetch_user/1` swallows the structured errors, so the function doesn't need to unpack them.

Order matters when wiring it in. `ParseBody` goes after `Tesla.Middleware.Telemetry` (so Telemetry records its `{:error, _}` as the request's result) and before `Tesla.Middleware.JSON` (so the body is already decoded when `ParseBody` sees it):

```elixir
defp client do
  Tesla.client([
    {Tesla.Middleware.BaseUrl, "https://api.acme.com"},
    {Tesla.Middleware.Telemetry, metadata: %{service: :acme}},
    ParseBody,
    Tesla.Middleware.JSON
  ])
end
```

### A note on `Tesla.get!`

If retrying or falling back on a transient outage isn't part of how the caller actually behaves, `:service_unavailable` is ceremony. Application code doesn't pattern-match `{:error, :service_unavailable}` on every `Repo.get/2`. We assume the database works; if it doesn't, the request crashes and the supervisor or web framework deals with it.

You can apply the same discipline to an external API. Use `Tesla.get!` instead of `Tesla.get`, drop `:service_unavailable` from the contract, and let any failed request become a `Tesla.Error` exception. Phoenix turns it into a 500. Oban retries the job. The two clauses left in `fetch_user/1` collapse to:

```elixir
case Tesla.get!(...) do
  %Tesla.Env{status: 200, body: user} -> {:ok, user}
  %Tesla.Env{status: 404} -> {:error, :not_found}
end
```

Whether to do this depends on the API's stability and the caller's context.

## When it wants to be data

Most parsers are boilerplate: required fields, ISO timestamps, nullability checks. A schema handles that better than a function. [`tesla_middleware_mold`](https://hex.pm/packages/tesla_middleware_mold) and [Mold](https://hex.pm/packages/mold) give you that. `fetch_user/1` with a schema:

```elixir
def fetch_user(id) do
  case Tesla.get(client(), "/users/#{id}", opts: [mold: %{200 => user_schema(), 404 => nil}]) do
    {:ok, %Tesla.Env{status: 200, body: user}} -> {:ok, user}
    {:ok, %Tesla.Env{status: 404}} -> {:error, :not_found}
    {:error, _} -> {:error, :service_unavailable}
  end
end

defp user_schema do
  %{
    id: :string,
    first_name: :string,
    last_name: :string,
    email: :string,
    created_at: :datetime
  }
end
```

`200 => schema` runs `Mold.parse/2`. `404 => nil` accepts the response without parsing. Anything else fails the request.

The function shape Mold accepts as a parser is the same one the middleware accepts (`body -> {:ok, term} | {:error, reason}`), so you can mix schemas with hand-written parsers in the same map, depending on which is cleaner for which response.

Nothing in this article requires `tesla_middleware_mold`. The hand-rolled `ParseBody` above is around 20 lines once you collapse the formatting; dropping it into your own codebase gives you the same telemetry behavior. Reach for the library when you also want to stop hand-writing parsers.
