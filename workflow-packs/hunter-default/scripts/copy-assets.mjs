import { copyFileSync, mkdirSync } from "node:fs";
import { URL } from "node:url";

const assets = ["change-delivery.v1.json", "task-delivery.v1.json"];
const outputDirectory = new URL("../dist/", import.meta.url);

mkdirSync(outputDirectory, { recursive: true });
for (const asset of assets) {
  copyFileSync(new URL(`../${asset}`, import.meta.url), new URL(asset, outputDirectory));
}
