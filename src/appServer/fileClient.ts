import type {
  FsGetMetadataParams,
  FsGetMetadataResponse,
  FsReadFileParams,
  FsReadFileResponse,
} from "../protocol/generated";
import type { RequestHandle, ResultValidator } from "../protocol/rpc";
import {
  validateFsGetMetadataResponse,
  validateFsReadFileResponse,
} from "../protocol/validation";
import type { AppServerSession } from "./session";

export interface FileClient {
  getMetadata(path: string): RequestHandle<FsGetMetadataResponse>;
  readFile(path: string): RequestHandle<FsReadFileResponse>;
}

export class AppServerFileClient implements FileClient {
  constructor(private readonly session: Pick<AppServerSession, "sendRequest">) {}

  getMetadata(path: string): RequestHandle<FsGetMetadataResponse> {
    const params: FsGetMetadataParams = { path };
    return this.session.sendRequest({
      method: "fs/getMetadata",
      params,
      validateResult: fsGetMetadataResponseValidator,
    });
  }

  readFile(path: string): RequestHandle<FsReadFileResponse> {
    const params: FsReadFileParams = { path };
    return this.session.sendRequest({
      method: "fs/readFile",
      params,
      validateResult: fsReadFileResponseValidator,
    });
  }
}

const fsGetMetadataResponseValidator: ResultValidator<FsGetMetadataResponse> =
  validateFsGetMetadataResponse;
const fsReadFileResponseValidator: ResultValidator<FsReadFileResponse> =
  validateFsReadFileResponse;
