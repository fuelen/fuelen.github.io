import { defineAstroPaperConfig } from "./src/types/config";

export default defineAstroPaperConfig({
  site: {
    url: "https://fuelen.github.io/",
    title: "Artur Plysiuk",
    description: "Articles by Artur Plysiuk.",
    author: "Artur Plysiuk",
    profile: "https://github.com/fuelen",
    ogImage: "default-og.jpg",
    lang: "en",
    timezone: "Europe/Kyiv",
    dir: "ltr",
  },
  posts: {
    perPage: 4,
    scheduledPostMargin: 15 * 60 * 1000,
  },
  features: {
    lightAndDarkMode: true,
    dynamicOgImage: true,
    showBackButton: true,
  },
  socials: [
    { name: "github", url: "https://github.com/fuelen" },
    { name: "x", url: "https://x.com/fuelen" },
  ],
});
