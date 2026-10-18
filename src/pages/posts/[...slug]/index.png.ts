import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { fontData, experimental_getFontFileURL } from "astro:assets";
import satori from "satori";
import sharp from "sharp";
import { getFontPathByWeight } from "@/utils/getFontPathByWeight";
import { getPostSlug } from "@/utils/getPostPaths";
import config from "@/config";

export async function getStaticPaths() {
  if (!config.features.dynamicOgImage) return [];

  const posts = await getCollection("posts").then(posts =>
    posts.filter(({ data }) => !data.draft && !data.ogImage)
  );

  return posts.map(post => ({
    params: { slug: getPostSlug(post.id, post.filePath) },
    props: post,
  }));
}

export const GET: APIRoute = async ({ props, url }) => {
  if (!config.features.dynamicOgImage) {
    return new Response(null, { status: 404, statusText: "Not found" });
  }

  const fonts = fontData["--font-inter"];
  const regularFontPath = getFontPathByWeight(fonts, 400);
  const semiboldFontPath = getFontPathByWeight(fonts, 600);

  if (regularFontPath === undefined || semiboldFontPath === undefined) {
    throw new Error("Cannot find the font path.");
  }

  const [regularData, semiboldData] = await Promise.all([
    fetch(experimental_getFontFileURL(regularFontPath, url)).then(res =>
      res.arrayBuffer()
    ),
    fetch(experimental_getFontFileURL(semiboldFontPath, url)).then(res =>
      res.arrayBuffer()
    ),
  ]);

  const svg = await satori(
    {
      type: "div",
      props: {
        style: {
          background: "#171615",
          color: "#eeeae4",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 84px",
          fontFamily: "Inter",
        },
        children: [
          {
            type: "div",
            props: {
              style: {
                color: "#f08a62",
                fontSize: 24,
                fontWeight: 600,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
              },
              children: "ARTICLE",
            },
          },
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                fontSize: 62,
                fontWeight: 600,
                letterSpacing: "-0.04em",
                lineHeight: 1.12,
                maxHeight: 350,
                overflow: "hidden",
              },
              children: props.data.title,
            },
          },
          {
            type: "div",
            props: {
              style: {
                borderTop: "2px solid #3a3733",
                color: "#aaa39b",
                display: "flex",
                justifyContent: "space-between",
                fontSize: 24,
                paddingTop: 24,
              },
              children: [
                { type: "span", props: { children: config.site.author } },
                {
                  type: "span",
                  props: { children: new URL(config.site.url).hostname },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      embedFont: true,
      fonts: [
        { name: "Inter", data: regularData, weight: 400, style: "normal" },
        { name: "Inter", data: semiboldData, weight: 600, style: "normal" },
      ],
    }
  );

  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

  return new Response(new Uint8Array(pngBuffer), {
    headers: { "Content-Type": "image/png" },
  });
};
