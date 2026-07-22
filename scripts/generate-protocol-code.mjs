#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { compile } from "json-schema-to-typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = dirname(scriptDirectory);
const schemaDirectory = join(projectDirectory, "protocol", "schema");
const outputDirectory = join(projectDirectory, "src", "protocol", "generated");
const typeOutputDirectory = join(outputDirectory, "types");
const checkOnly = parseArguments(process.argv.slice(2));
const generatedOutputs = new Map();

const schemaDeclarations = [
  {
    typeName: "JSONRPCMessage",
    schemaPath: "JSONRPCMessage.json",
    validatorName: "validateJSONRPCMessage",
  },
  { typeName: "ClientRequest", schemaPath: "ClientRequest.json" },
  { typeName: "ClientNotification", schemaPath: "ClientNotification.json" },
  {
    typeName: "ServerRequest",
    schemaPath: "ServerRequest.json",
    validatorName: "validateServerRequest",
  },
  {
    typeName: "ServerNotification",
    schemaPath: "ServerNotification.json",
    validatorName: "validateServerNotification",
  },
  { typeName: "InitializeParams", schemaPath: "v1/InitializeParams.json" },
  {
    typeName: "InitializeResponse",
    schemaPath: "v1/InitializeResponse.json",
    validatorName: "validateInitializeResponse",
  },
  { typeName: "ThreadListParams", schemaPath: "v2/ThreadListParams.json" },
  {
    typeName: "ThreadListResponse",
    schemaPath: "v2/ThreadListResponse.json",
    validatorName: "validateThreadListResponse",
  },
  { typeName: "ThreadReadParams", schemaPath: "v2/ThreadReadParams.json" },
  {
    typeName: "ThreadReadResponse",
    schemaPath: "v2/ThreadReadResponse.json",
    validatorName: "validateThreadReadResponse",
  },
  { typeName: "ThreadResumeParams", schemaPath: "v2/ThreadResumeParams.json" },
  {
    typeName: "ThreadResumeResponse",
    schemaPath: "v2/ThreadResumeResponse.json",
    validatorName: "validateThreadResumeResponse",
  },
  {
    typeName: "ThreadTurnsListParams",
    schemaPath: "v2/ThreadTurnsListParams.json",
  },
  {
    typeName: "ThreadTurnsListResponse",
    schemaPath: "v2/ThreadTurnsListResponse.json",
    validatorName: "validateThreadTurnsListResponse",
  },
  {
    typeName: "ThreadUnsubscribeParams",
    schemaPath: "v2/ThreadUnsubscribeParams.json",
  },
  {
    typeName: "ThreadUnsubscribeResponse",
    schemaPath: "v2/ThreadUnsubscribeResponse.json",
    validatorName: "validateThreadUnsubscribeResponse",
  },
  { typeName: "ThreadArchiveParams", schemaPath: "v2/ThreadArchiveParams.json" },
  {
    typeName: "ThreadArchiveResponse",
    schemaPath: "v2/ThreadArchiveResponse.json",
    validatorName: "validateThreadArchiveResponse",
  },
  { typeName: "ThreadUnarchiveParams", schemaPath: "v2/ThreadUnarchiveParams.json" },
  {
    typeName: "ThreadUnarchiveResponse",
    schemaPath: "v2/ThreadUnarchiveResponse.json",
    validatorName: "validateThreadUnarchiveResponse",
  },
  { typeName: "ThreadDeleteParams", schemaPath: "v2/ThreadDeleteParams.json" },
  {
    typeName: "ThreadDeleteResponse",
    schemaPath: "v2/ThreadDeleteResponse.json",
    validatorName: "validateThreadDeleteResponse",
  },
  { typeName: "ThreadStartParams", schemaPath: "v2/ThreadStartParams.json" },
  {
    typeName: "ThreadStartResponse",
    schemaPath: "v2/ThreadStartResponse.json",
    validatorName: "validateThreadStartResponse",
  },
  {
    typeName: "ThreadSettingsUpdateParams",
    schemaPath: "v2/ThreadSettingsUpdateParams.json",
  },
  {
    typeName: "ThreadSettingsUpdateResponse",
    schemaPath: "v2/ThreadSettingsUpdateResponse.json",
    validatorName: "validateThreadSettingsUpdateResponse",
  },
  { typeName: "TurnStartParams", schemaPath: "v2/TurnStartParams.json" },
  {
    typeName: "TurnStartResponse",
    schemaPath: "v2/TurnStartResponse.json",
    validatorName: "validateTurnStartResponse",
  },
  { typeName: "TurnSteerParams", schemaPath: "v2/TurnSteerParams.json" },
  {
    typeName: "TurnSteerResponse",
    schemaPath: "v2/TurnSteerResponse.json",
    validatorName: "validateTurnSteerResponse",
  },
  { typeName: "TurnInterruptParams", schemaPath: "v2/TurnInterruptParams.json" },
  {
    typeName: "TurnInterruptResponse",
    schemaPath: "v2/TurnInterruptResponse.json",
    validatorName: "validateTurnInterruptResponse",
  },
  { typeName: "ModelListParams", schemaPath: "v2/ModelListParams.json" },
  {
    typeName: "ModelListResponse",
    schemaPath: "v2/ModelListResponse.json",
    validatorName: "validateModelListResponse",
  },
  { typeName: "SkillsListParams", schemaPath: "v2/SkillsListParams.json" },
  {
    typeName: "SkillsListResponse",
    schemaPath: "v2/SkillsListResponse.json",
    validatorName: "validateSkillsListResponse",
  },
  { typeName: "FuzzyFileSearchParams", schemaPath: "FuzzyFileSearchParams.json" },
  {
    typeName: "FuzzyFileSearchResponse",
    schemaPath: "FuzzyFileSearchResponse.json",
    validatorName: "validateFuzzyFileSearchResponse",
  },
  {
    typeName: "PermissionProfileListParams",
    schemaPath: "v2/PermissionProfileListParams.json",
  },
  {
    typeName: "PermissionProfileListResponse",
    schemaPath: "v2/PermissionProfileListResponse.json",
    validatorName: "validatePermissionProfileListResponse",
  },
  { typeName: "ConfigReadParams", schemaPath: "v2/ConfigReadParams.json" },
  {
    typeName: "ConfigReadResponse",
    schemaPath: "v2/ConfigReadResponse.json",
    validatorName: "validateConfigReadResponse",
  },
  {
    typeName: "ConfigRequirementsReadResponse",
    schemaPath: "v2/ConfigRequirementsReadResponse.json",
    validatorName: "validateConfigRequirementsReadResponse",
  },
  { typeName: "AppsListParams", schemaPath: "v2/AppsListParams.json" },
  {
    typeName: "AppsListResponse",
    schemaPath: "v2/AppsListResponse.json",
    validatorName: "validateAppsListResponse",
  },
  { typeName: "PluginListParams", schemaPath: "v2/PluginListParams.json" },
  {
    typeName: "PluginListResponse",
    schemaPath: "v2/PluginListResponse.json",
    validatorName: "validatePluginListResponse",
  },
  {
    typeName: "ThreadCompactStartParams",
    schemaPath: "v2/ThreadCompactStartParams.json",
  },
  {
    typeName: "ThreadCompactStartResponse",
    schemaPath: "v2/ThreadCompactStartResponse.json",
    validatorName: "validateThreadCompactStartResponse",
  },
  { typeName: "ReviewStartParams", schemaPath: "v2/ReviewStartParams.json" },
  {
    typeName: "ReviewStartResponse",
    schemaPath: "v2/ReviewStartResponse.json",
    validatorName: "validateReviewStartResponse",
  },
  { typeName: "ThreadForkParams", schemaPath: "v2/ThreadForkParams.json" },
  {
    typeName: "ThreadForkResponse",
    schemaPath: "v2/ThreadForkResponse.json",
    validatorName: "validateThreadForkResponse",
  },
  { typeName: "FsReadFileParams", schemaPath: "v2/FsReadFileParams.json" },
  {
    typeName: "FsReadFileResponse",
    schemaPath: "v2/FsReadFileResponse.json",
    validatorName: "validateFsReadFileResponse",
  },
  { typeName: "FsGetMetadataParams", schemaPath: "v2/FsGetMetadataParams.json" },
  {
    typeName: "FsGetMetadataResponse",
    schemaPath: "v2/FsGetMetadataResponse.json",
    validatorName: "validateFsGetMetadataResponse",
  },
  {
    typeName: "GetAccountRateLimitsResponse",
    schemaPath: "v2/GetAccountRateLimitsResponse.json",
    validatorName: "validateGetAccountRateLimitsResponse",
  },
  {
    typeName: "CommandExecutionRequestApprovalResponse",
    schemaPath: "CommandExecutionRequestApprovalResponse.json",
  },
  {
    typeName: "FileChangeRequestApprovalResponse",
    schemaPath: "FileChangeRequestApprovalResponse.json",
  },
  {
    typeName: "PermissionsRequestApprovalResponse",
    schemaPath: "PermissionsRequestApprovalResponse.json",
  },
  {
    typeName: "ToolRequestUserInputResponse",
    schemaPath: "ToolRequestUserInputResponse.json",
  },
  {
    typeName: "McpServerElicitationRequestResponse",
    schemaPath: "McpServerElicitationRequestResponse.json",
  },
  {
    typeName: "ApplyPatchApprovalResponse",
    schemaPath: "ApplyPatchApprovalResponse.json",
  },
  {
    typeName: "ExecCommandApprovalResponse",
    schemaPath: "ExecCommandApprovalResponse.json",
  },
  {
    typeName: "ConsumeAccountRateLimitResetCreditResponse",
    schemaPath: "v2/ConsumeAccountRateLimitResetCreditResponse.json",
    validatorName: "validateConsumeAccountRateLimitResetCreditResponse",
  },
  {
    typeName: "ConsumeAccountRateLimitResetCreditParams",
    schemaPath: "v2/ConsumeAccountRateLimitResetCreditParams.json",
  },
  {
    typeName: "GetAccountTokenUsageResponse",
    schemaPath: "v2/GetAccountTokenUsageResponse.json",
    validatorName: "validateGetAccountTokenUsageResponse",
  },
];

const validatorDeclarations = schemaDeclarations.filter(
  ({ validatorName }) => validatorName !== undefined,
);

const numericFormats = Object.freeze({
  int32: { minimum: -2_147_483_648, maximum: 2_147_483_647 },
  int64: { minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
  uint: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  uint16: { minimum: 0, maximum: 65_535 },
  uint32: { minimum: 0, maximum: 4_294_967_295 },
  uint64: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  double: {},
});

const upstreamCommit = await validateSchemaBaseline();

const generatedHeader = [
  "// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改",
  `// Codex app-server 上游提交：${upstreamCommit}`,
  "",
].join("\n");

const schemas = new Map();
for (const { schemaPath } of schemaDeclarations) {
  schemas.set(schemaPath, await readSchema(schemaPath));
}

for (const { typeName, schemaPath } of schemaDeclarations) {
  const schema = schemas.get(schemaPath);
  const source = await compile(schema, typeName, {
    additionalProperties: true,
    bannerComment: generatedHeader.trimEnd(),
    cwd: schemaDirectory,
    enableConstEnums: false,
    format: true,
    strictIndexSignatures: true,
    style: {
      bracketSpacing: true,
      printWidth: 100,
      semi: true,
      singleQuote: false,
      tabWidth: 2,
      trailingComma: "all",
      useTabs: false,
    },
    unknownAny: true,
  });

  addGeneratedOutput(join(typeOutputDirectory, `${typeName}.ts`), source);
}

const serverRequestMethods = extractDiscriminatedMethods(
  schemas.get("ServerRequest.json"),
  "ServerRequest",
);
const serverNotificationMethods = extractDiscriminatedMethods(
  schemas.get("ServerNotification.json"),
  "ServerNotification",
);

addGeneratedOutput(
  join(outputDirectory, "methods.ts"),
  `${generatedHeader}${renderMethodCollection("SERVER_REQUEST", serverRequestMethods)}\n${renderMethodCollection(
    "SERVER_NOTIFICATION",
    serverNotificationMethods,
  )}`,
);

addGeneratedOutput(
  join(outputDirectory, "index.ts"),
  `${generatedHeader}export const APP_SERVER_SCHEMA_COMMIT = ${JSON.stringify(upstreamCommit)} as const;\n\n${schemaDeclarations
    .map(({ typeName }) => `export type { ${typeName} } from "./types/${typeName}";`)
    .join("\n")}\n\nexport {\n  KNOWN_SERVER_NOTIFICATION_METHODS,\n  KNOWN_SERVER_REQUEST_METHODS,\n  isKnownServerNotificationMethod,\n  isKnownServerRequestMethod,\n} from "./methods";\nexport type {\n  KnownServerNotificationMethod,\n  KnownServerRequestMethod,\n} from "./methods";\n`,
);

const ajv = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  code: { esm: true, lines: true, optimize: true, source: true },
  strict: true,
  strictNumbers: true,
  validateFormats: true,
});

const standaloneExports = {};
for (const { validatorName, typeName, schemaPath } of validatorDeclarations) {
  const schemaId = `urn:codex-app-server:${upstreamCommit}:${typeName}`;
  const validationSchema = tightenNumericFormats(structuredClone(schemas.get(schemaPath)));
  validationSchema.$id = schemaId;
  ajv.addSchema(validationSchema, schemaId);
  standaloneExports[validatorName] = schemaId;
}

const standaloneSource = makeBrowserCompatibleStandalone(standaloneCode(ajv, standaloneExports));
addGeneratedOutput(
  join(outputDirectory, "validators.js"),
  `${generatedHeader}${standaloneSource}\n`,
);

addGeneratedOutput(
  join(outputDirectory, "validators.d.ts"),
  `${generatedHeader}import type { ErrorObject } from "ajv";\n\nimport type {\n${validatorDeclarations
    .map(({ typeName }) => typeName)
    .toSorted()
    .map((typeName) => `  ${typeName},`)
    .join("\n")}\n} from "./index";\n\nexport interface StandaloneValidateFunction<T> {\n  (value: unknown): value is T;\n  readonly errors: readonly ErrorObject[] | null;\n}\n\n${validatorDeclarations
    .map(
      ({ validatorName, typeName }) =>
        `export const ${validatorName}: StandaloneValidateFunction<${typeName}>;`,
    )
    .join("\n")}\n`,
);

await persistOrCheckGeneratedOutputs();

async function readSchema(schemaPath) {
  const absolutePath = join(schemaDirectory, schemaPath);
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

async function validateSchemaBaseline() {
  const upstreamCommitPath = join(schemaDirectory, "UPSTREAM_COMMIT");
  const upstreamCommitSource = await readFile(upstreamCommitPath, "utf8");
  if (!/^[0-9a-f]{40}\n$/u.test(upstreamCommitSource)) {
    throw new Error("protocol/schema/UPSTREAM_COMMIT 不是完整 Git 提交号");
  }
  const commit = upstreamCommitSource.slice(0, -1);

  const checksumManifestPath = join(schemaDirectory, "SHA256SUMS");
  const checksumManifest = await readFile(checksumManifestPath, "utf8");
  const entries = parseChecksumManifest(checksumManifest);
  const actualSchemaPaths = await collectSchemaPaths(schemaDirectory);
  const listedSchemaPaths = entries.map(({ schemaPath }) => schemaPath);
  const listedSchemaPathSet = new Set(listedSchemaPaths);
  const actualSchemaPathSet = new Set(actualSchemaPaths);
  const missingPaths = listedSchemaPaths.filter((schemaPath) => !actualSchemaPathSet.has(schemaPath));
  const extraPaths = actualSchemaPaths.filter((schemaPath) => !listedSchemaPathSet.has(schemaPath));

  if (missingPaths.length > 0 || extraPaths.length > 0) {
    const details = [
      ...missingPaths.map((schemaPath) => `清单文件缺失：${schemaPath}`),
      ...extraPaths.map((schemaPath) => `存在未列入清单的 JSON：${schemaPath}`),
    ];
    throw new Error(`协议 Schema 清单与目录不一致\n${details.join("\n")}`);
  }

  for (const { checksum, schemaPath } of entries) {
    const contents = await readFile(join(schemaDirectory, ...schemaPath.split("/")));
    const actualChecksum = createHash("sha256").update(contents).digest("hex");
    if (actualChecksum !== checksum) {
      throw new Error(`协议 Schema 校验失败：${schemaPath}`);
    }
  }

  return commit;
}

function parseChecksumManifest(source) {
  if (!source.endsWith("\n")) {
    throw new Error("protocol/schema/SHA256SUMS 必须以换行结尾");
  }

  const lines = source.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error("protocol/schema/SHA256SUMS 不能为空或包含空行");
  }

  const entries = [];
  const seenPaths = new Set();
  let previousPath;
  for (const [index, line] of lines.entries()) {
    const match = /^([0-9a-f]{64})  protocol\/schema\/(.+)$/u.exec(line);
    if (match === null) {
      throw new Error(`protocol/schema/SHA256SUMS 第 ${index + 1} 行格式无效`);
    }

    const [, checksum, schemaPath] = match;
    validateManifestSchemaPath(schemaPath, index + 1);
    if (seenPaths.has(schemaPath)) {
      throw new Error(`protocol/schema/SHA256SUMS 包含重复路径：${schemaPath}`);
    }
    if (previousPath !== undefined && comparePaths(previousPath, schemaPath) >= 0) {
      throw new Error("protocol/schema/SHA256SUMS 未按路径严格排序");
    }

    entries.push({ checksum, schemaPath });
    seenPaths.add(schemaPath);
    previousPath = schemaPath;
  }

  return entries;
}

function validateManifestSchemaPath(schemaPath, lineNumber) {
  const segments = schemaPath.split("/");
  const absolutePath = resolve(schemaDirectory, ...segments);
  const schemaDirectoryPrefix = `${resolve(schemaDirectory)}${sep}`;
  const isSafePath =
    schemaPath.endsWith(".json") &&
    !posix.isAbsolute(schemaPath) &&
    !schemaPath.includes("\\") &&
    !schemaPath.includes("\0") &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    posix.normalize(schemaPath) === schemaPath &&
    absolutePath.startsWith(schemaDirectoryPrefix);

  if (!isSafePath) {
    throw new Error(`protocol/schema/SHA256SUMS 第 ${lineNumber} 行路径不安全`);
  }
}

async function collectSchemaPaths(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort(({ name: left }, { name: right }) => comparePaths(left, right));

  const schemaPaths = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      schemaPaths.push(...(await collectSchemaPaths(absolutePath, relativePath)));
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`protocol/schema 不允许符号链接：${relativePath}`);
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      schemaPaths.push(relativePath);
    }
  }

  return schemaPaths;
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function extractDiscriminatedMethods(schema, schemaName) {
  if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
    throw new Error(`${schemaName} 根节点不是非空 oneOf 判别联合`);
  }

  const methods = schema.oneOf.map((variant, index) => {
    const methodValues = variant?.properties?.method?.enum;
    if (!Array.isArray(methodValues) || methodValues.length !== 1 || typeof methodValues[0] !== "string") {
      throw new Error(`${schemaName}.oneOf[${index}] 缺少唯一 method 字面量`);
    }
    return methodValues[0];
  });

  if (new Set(methods).size !== methods.length) {
    throw new Error(`${schemaName} 包含重复 method 字面量`);
  }

  return methods.toSorted();
}

function renderMethodCollection(namePrefix, methods) {
  const constantName = `KNOWN_${namePrefix}_METHODS`;
  const methodGroupName = toPascalCase(namePrefix);
  const typeName = `Known${methodGroupName}Method`;
  const predicateName = `isKnown${methodGroupName}Method`;
  const values = methods.map((method) => `  ${JSON.stringify(method)},`).join("\n");

  return `export const ${constantName} = [\n${values}\n] as const;\n\nexport type ${typeName} = (typeof ${constantName})[number];\n\nconst ${lowerFirst(typeName)}Set: ReadonlySet<string> = new Set(${constantName});\n\nexport function ${predicateName}(method: string): method is ${typeName} {\n  return ${lowerFirst(typeName)}Set.has(method);\n}\n`;
}

function toPascalCase(value) {
  return value
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => {
      const normalizedPart = part.toLowerCase();
      return `${normalizedPart[0].toUpperCase()}${normalizedPart.slice(1)}`;
    })
    .join("");
}

function lowerFirst(value) {
  return `${value[0].toLowerCase()}${value.slice(1)}`;
}

function tightenNumericFormats(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      tightenNumericFormats(item);
    }
    return value;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (typeof value.format === "string" && Object.hasOwn(numericFormats, value.format)) {
    const limits = numericFormats[value.format];
    delete value.format;
    if (limits.minimum !== undefined) {
      value.minimum = Math.max(value.minimum ?? -Infinity, limits.minimum);
    }
    if (limits.maximum !== undefined) {
      value.maximum = Math.min(value.maximum ?? Infinity, limits.maximum);
    }
  }

  for (const child of Object.values(value)) {
    tightenNumericFormats(child);
  }
  return value;
}

function makeBrowserCompatibleStandalone(source) {
  const unicodeLengthRequire =
    /const (func\d+) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/gu;
  let usesUnicodeLength = false;
  const esmSource = source.replace(unicodeLengthRequire, (_match, functionName) => {
    usesUnicodeLength = true;
    return `const ${functionName} = countUnicodeCodePoints;`;
  });

  if (esmSource.includes("require(")) {
    throw new Error("Ajv standalone 产物包含尚未转换的 CommonJS require");
  }

  if (!usesUnicodeLength) {
    return esmSource;
  }

  return `function countUnicodeCodePoints(value) {\n  let length = 0;\n  for (const character of value) {\n    void character;\n    length += 1;\n  }\n  return length;\n}\n\n${esmSource}`;
}

function parseArguments(arguments_) {
  if (arguments_.length === 0) {
    return false;
  }
  if (arguments_.length === 1 && arguments_[0] === "--check") {
    return true;
  }
  throw new Error("用法：node scripts/generate-protocol-code.mjs [--check]");
}

function addGeneratedOutput(path, source) {
  const normalizedSource = source.replaceAll("\r\n", "\n").replace(/\s+$/u, "") + "\n";
  if (!normalizedSource.startsWith(generatedHeader)) {
    throw new Error(`生成物头部与 protocol/schema/UPSTREAM_COMMIT 不一致：${relative(projectDirectory, path)}`);
  }
  generatedOutputs.set(path, normalizedSource);
}

async function persistOrCheckGeneratedOutputs() {
  if (!checkOnly) {
    await mkdir(typeOutputDirectory, { recursive: true });
    for (const [path, source] of generatedOutputs) {
      await writeFile(path, source, "utf8");
      process.stdout.write(`generated ${relative(projectDirectory, path)}\n`);
    }
    return;
  }

  const mismatches = [];
  for (const [path, expectedSource] of generatedOutputs) {
    let currentSource;
    try {
      currentSource = await readFile(path, "utf8");
    } catch {
      currentSource = undefined;
    }

    if (currentSource !== expectedSource) {
      mismatches.push(relative(projectDirectory, path));
    }
  }

  if (mismatches.length > 0) {
    process.stderr.write(`协议生成物缺失或已过期：\n${mismatches.map((path) => `- ${path}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`协议生成物与 ${upstreamCommit} 一致\n`);
}
