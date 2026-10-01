import type { FileClient } from "../appServer";
import { decodeDataImageUrl } from "./dataImage";
import { decodePreview } from "./filePreview";
import { resolveLink } from "./linkResolver";
import { readRemoteImage } from "../transport/remoteImage";

export interface MarkdownImageResource {
  readonly blob: Blob;
  readonly target: string;
}

export async function loadMarkdownImage(
  source: string,
  client: FileClient | null,
  cwd: string | null,
  remoteReader: (url: string) => Promise<string> = readRemoteImage,
): Promise<MarkdownImageResource> {
  if (/^data:/iu.test(source)) {
    const image = decodeDataImageUrl(source);
    if (image === null) throw new Error("图片数据无效、格式不支持或超过 16 MiB");
    return { blob: image.blob, target: source };
  }
  const link = resolveLink(source, cwd);
  if (link.type === "blocked") throw new Error(link.reason);
  if (link.type === "external") {
    const dataUrl = await remoteReader(link.url);
    const image = decodeDataImageUrl(dataUrl);
    if (image === null) throw new Error("服务器返回了无效的图片数据");
    return { blob: image.blob, target: dataUrl };
  }
  if (link.type !== "file") throw new Error("此地址不是服务器上的图片文件");
  if (client === null) throw new Error("当前服务器连接不可用，无法读取图片");
  if (!/\.(?:png|jpe?g|gif|webp|svg)$/iu.test(link.path)) {
    throw new Error("不支持此图片格式");
  }
  const metadata = await client.getMetadata(link.path).result;
  if (!metadata.isFile) throw new Error("此路径不是图片文件");
  const response = await client.readFile(link.path).result;
  const image = decodePreview(link.path, response.dataBase64);
  if (image.type === "tooLarge") throw new Error("图片超过 16 MiB，无法内嵌显示");
  if (image.type !== "image") throw new Error("图片内容无效");
  return { blob: image.blob, target: encodeURI(link.path).replace(/#/gu, "%23") };
}
