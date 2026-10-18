import type { APIRoute } from "astro";
import satori from "satori";
import sharp from "sharp";
import { fontData, experimental_getFontFileURL } from "astro:assets";
import { getFontPathByWeight } from "@/utils/getFontPathByWeight";
import config from "@/config";

export const GET: APIRoute = async context => {
  const fonts = fontData["--font-inter"];
  const regularFontPath = getFontPathByWeight(fonts, 400);
  const semiboldFontPath = getFontPathByWeight(fonts, 600);

  if (regularFontPath === undefined || semiboldFontPath === undefined) {
    throw new Error("Cannot find the font path.");
  }

  const [regularData, semiboldData] = await Promise.all([
    fetch(experimental_getFontFileURL(regularFontPath, context.url)).then(res =>
      res.arrayBuffer()
    ),
    fetch(experimental_getFontFileURL(semiboldFontPath, context.url)).then(
      res => res.arrayBuffer()
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
              children: "ARTUR PLYSIUK",
            },
          },
          {
            type: "div",
            props: {
              style: { display: "flex", flexDirection: "column" },
              children: [
                {
                  type: "div",
                  props: {
                    style: {
                      fontSize: 88,
                      fontWeight: 600,
                      letterSpacing: "-0.045em",
                      lineHeight: 1.05,
                    },
                    children: config.site.title,
                  },
                },
                {
                  type: "div",
                  props: {
                    style: {
                      color: "#aaa39b",
                      fontSize: 32,
                      marginTop: 24,
                    },
                    children: "Software engineer working with Elixir.",
                  },
                },
              ],
            },
          },
          {
            type: "div",
            props: {
              style: {
                borderTop: "2px solid #3a3733",
                color: "#aaa39b",
                display: "flex",
                fontSize: 24,
                paddingTop: 24,
              },
              children: new URL(config.site.url).hostname,
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
