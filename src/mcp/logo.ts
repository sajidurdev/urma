import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const logoBase64 = readFileSync(
  fileURLToPath(new URL("../../../assets/urma-logo.png", import.meta.url)),
  "base64",
);

export const URMA_SERVER_ICONS = [
  {
    src: `data:image/png;base64,${logoBase64}`,
    mimeType: "image/png",
    sizes: ["256x256"],
  },
];
