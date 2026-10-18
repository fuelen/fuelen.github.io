---
title: "Writing dynamic Ecto queries with Composite"
pubDatetime: 2024-02-19T18:46:02Z
modDatetime: 2024-02-19T18:55:43Z
description: "Learn how to write dynamic Ecto queries efficiently with Composite, optimizing code organization and query composition for better performance and readability compared to traditional methods."
tags:
  - "elixir"
  - "ecto"
---
There is already an existing article in Ecto docs about dynamic queries https://hexdocs.pm/ecto/dynamic-queries.html so you might think why another article is needed.

Indeed, the article from docs contains a solid foundation. However, I suggest organizing the final code differently. Let's examine the code:
```elixir
def filter(params) do
  Post
  |> join(:inner, [p], assoc(p, :authors), as: :authors)
  |> order_by(^filter_order_by(params["order_by"]))
  |> where(^filter_where(params))
end

def filter_order_by("published_at_desc"),
  do: [desc: dynamic([p], p.published_at)]

def filter_order_by("published_at"),
  do: dynamic([p], p.published_at)

def filter_order_by("author_name_desc"),
  do: [desc: dynamic([authors: a], a.name)]

def filter_order_by("author_name"),
  do: dynamic([authors: a], a.name)

def filter_order_by(_),
  do: []

def filter_where(params) do
  Enum.reduce(params, dynamic(true), fn
    {"author", value}, dynamic ->
      dynamic([authors: a], ^dynamic and a.name == ^value)

    {"category", value}, dynamic ->
      dynamic([p], ^dynamic and p.category == ^value)

    {"published_at", value}, dynamic ->
      dynamic([p], ^dynamic and p.published_at > ^value)

    {_, _}, dynamic ->
      # Not a where parameter
      dynamic
  end)
end
```
One of the goals of the article was to demonstrate the use of the `Ecto.Query.dynamic/2` macro. However, dynamic queries are not only about the usage of the `Ecto.Query.dynamic/2` macro. Ecto queries are composable by design. Therefore, writing dynamic Ecto queries is all about the optional application of functions. The ultimate aim is to compose a query by given input parameters and `Ecto.Query.dynamic/2` *may* not be needed at all.

I've observed various approaches to writing dynamic Ecto queries.
While I won't list them here, the [Composite](https://hex.pm/packages/composite) library is a result of refactoring those places. 

Let's look at the alternative implementation with Composite:
```elixir
def filter(params) do
  Post
  |> join(:inner, [p], assoc(p, :authors), as: :authors)
  |> Composite.new(params)
  |> Composite.param("order_by", &order_by(&1, ^order_instructions(&2)))
  |> Composite.param("author", &where(&1, [authors: a], a.name == ^name))
  |> Composite.param("category", &where(&1, category: ^&2))
  |> Composite.param("published_at", &where(&1, [p], p.published_at > ^&2))
end

defp order_instructions(value) do
  case value do
    "published_at_desc" -> [desc: :published_at]
    "published_at" -> [:published_at]
    "author_name_desc" -> [desc: dynamic([authors: a], a.name)]
    "author_name" -> dynamic([authors: a], a.name)
  end
end
```

Apart from having fewer lines of code, this implementation places all used parameters at the top level, eliminating the need to delve deep into the implementation of nested functions. Essentially, it resembles a router. 
`Composite.new/2` wraps the Ecto query into a `Composite` struct.

`Composite.param/3` function calls define how to modify a query if a given parameter is present. The presence of the parameter is controlled by the `:ignore?` option, which ignores the following values by default: `nil`, `""`, `[]`, `%{}`.

The third argument of the `Composite.param/3` function is a modifier function for the query. An important property of this function is that the first argument is an Ecto query, and the second argument is a value of the specified parameter. This is important, because this is one of the default patterns when writing Ecto queries, as it allows sequential composition using a pipe operator. Thus, with the named function the last instruction can be written as:
```elixir
# ...
|> Composite.param("published_at", &posts_published_after/2)
# ...
def posts_published_after(query, value) do
  where(query, [p], p.published_at > ^value)
end
```

You may have noticed, that the `:authors` association is always joined at the beginning of the query. It would be more efficient to optimize this part and join the association only when needed based on the input parameters. `Composite` can handle this by using *dependencies*. Each dependency is declared with the loader function which will be invoked before invoking the parameter handler.

```elixir
def filter(params) do
  Post
  |> Composite.new(params)
  |> Composite.param(
    "order_by",
    fn query, value -> order_by(query, ^order_instructions(value)) end,
    requires: fn
      "author_name" -> :authors
      "author_name_desc" -> :authors
      _ -> nil
    end
  )
  |> Composite.param("author", &where(&1, [authors: a], a.name == ^&2), requires: :authors)
  |> Composite.param("category", &where(&1, category: ^&2))
  |> Composite.param("published_at", &where(&1, [p], p.published_at > ^&2))
  |> Composite.dependency(:authors, &join(&1, :inner, [p], assoc(p, :authors), as: :authors))
end

defp order_instructions(value) do
  case value do
    "published_at_desc" -> [desc: :published_at]
    "published_at" -> [:published_at]
    "author_name_desc" -> [desc: dynamic([authors: a], a.name)]
    "author_name" -> dynamic([authors: a], a.name)
  end
end
```

To convert the struct back to Ecto query, we can call `Composite.apply/1` function at the end of the chain. This is done automatically by Ecto when you invoke functions from `Ecto.Repo` or `Ecto.Query` modules, because `Composite` implements the `Ecto.Queryable` protocol.

```elixir
%{"category" => "Open Source"}
|> filter()
|> Composite.apply()
#Ecto.Query<from p0 in Post, where: p0.category == ^"Open Source">
```

```elixir
%{
  "category" => "Open Source",
  "author" => "John Doe",
  "order_by" => "author_name"
}
|> filter()
|> Composite.apply()
# #Ecto.Query<from p0 in Post, join: a1 in assoc(p0, :authors), as: :authors,
#  where: a1.name == ^"John Doe", where: p0.category == ^"Open Source",
#  order_by: [asc: a1.name]>
```

This article doesn't describe all the features of Composite because the initial example is not very complex, reach out to [docs](https://hexdocs.pm/composite) for details. Source code is available on [GitHub](https://github.com/fuelen/composite)

That's it. Hope this helps :)
