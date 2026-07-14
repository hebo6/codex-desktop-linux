export function sanitizeSvg(source: string): string {
  const documentNode = new DOMParser().parseFromString(source, "image/svg+xml");
  if (documentNode.querySelector("parsererror") !== null) {
    throw new TypeError("invalid svg");
  }
  documentNode.querySelectorAll("script,style,foreignObject,iframe,object,embed").forEach((node) => node.remove());
  documentNode.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLocaleLowerCase();
      const value = attribute.value.trim().toLocaleLowerCase();
      if (
        name.startsWith("on") ||
        ((name === "href" || name.endsWith(":href")) && !value.startsWith("#")) ||
        (name === "style" && /url\s*\(/iu.test(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return new XMLSerializer().serializeToString(documentNode.documentElement);
}

export function sanitizeSvgDataUrl(source: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizeSvg(source))}`;
}
