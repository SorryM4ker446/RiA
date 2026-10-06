import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const config = [
  {
    ignores: [".desktop-data/**", ".desktop-runtime/**", ".next/**", "electron-dist/**", "out/**", "vendor/**"],
  },
  ...nextCoreWebVitals,
];

export default config;
