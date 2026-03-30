import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        "red-zone": "#DC2626",
        "amber-zone": "#D97706",
        "green-zone": "#16A34A",
      },
    },
  },
  plugins: [],
};
export default config;
