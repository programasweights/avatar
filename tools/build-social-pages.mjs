// Give the Gangnam deep link its own server-rendered metadata and the same app.
import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";

const dist = resolve(process.argv[2] || "dist");
const original = await readFile(resolve(dist, "index.html"), "utf8");
let html = original;
const url = "https://programasweights.com/avatar?example=gangnam";
const title = "Gangnam Style. Your direction. — Avatar Director";
const description = "Direct a dancing avatar with words. Dance Gangnam Style, keep it going on one foot, then switch to the opposite foot.";
const image = "https://programasweights.com/avatar/share-gangnam-v1.png";
const alt = "A blue-suited avatar dances Gangnam Style on one foot beside the words ‘Gangnam Style. Your direction.’";

function replaceOne(pattern, replacement) {
  if ([...html.matchAll(pattern)].length !== 1)
    throw new Error(`Expected one metadata field: ${pattern}`);
  html = html.replace(pattern, replacement);
}

for (const [key, value] of Object.entries({
  description,
  "og:title": title, "twitter:title": title,
  "og:description": description, "twitter:description": description,
  "og:url": url,
  "og:image": image, "twitter:image": image,
  "og:image:alt": alt, "twitter:image:alt": alt,
})) {
  replaceOne(new RegExp(`(<meta\\s+(?:name|property)="${key}"\\s+content=")[^"]*(")`, "g"),
    (_, before, after) => before + value + after);
}
replaceOne(/(<link\s+rel="canonical"\s+href=")[^"]*(")/g,
  (_, before, after) => before + url + after);
replaceOne(/<title>[^<]*<\/title>/g, () => `<title>${title}</title>`);
await access(resolve(dist, "share-gangnam-v1.png"));
await writeFile(resolve(dist, "gangnam.html"), html);
console.log("Built Gangnam metadata with the current app bundle.");
