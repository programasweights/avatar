export type CharacterLook = "jade" | "gangnam" | "mixamo";

export function isGangnamExample(search = window.location.search, pathname = window.location.pathname): boolean {
  return ["/gangnam", "/avatar/gangnam"].includes(pathname.replace(/\/$/, ""))
    || new URLSearchParams(search).get("example") === "gangnam";
}

export function initialCharacter(search = window.location.search, pathname = window.location.pathname): CharacterLook {
  const query = new URLSearchParams(search);
  const requested = query.get("character");
  if (requested === "mixamo" || requested === "gangnam" || requested === "jade") return requested;
  return isGangnamExample(search, pathname) ? "gangnam" : "jade";
}

export function characterUrl(character: CharacterLook) {
  const file = character === "mixamo"
    ? "local-assets/character.glb"
    : character === "gangnam"
      ? "assets/gangnam-character.glb"
      : "assets/character.glb";
  return `${import.meta.env.BASE_URL}${file}`;
}
