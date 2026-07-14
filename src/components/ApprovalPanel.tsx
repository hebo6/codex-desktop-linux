import { useEffect, useMemo, useState } from "react";

import type { PendingInteraction } from "../appServer";
import type { ServerRequest } from "../protocol/generated";
import styles from "./ApprovalPanel.module.css";

type CommandRequest = Extract<ServerRequest, { method: "item/commandExecution/requestApproval" }>;
type FileRequest = Extract<ServerRequest, { method: "item/fileChange/requestApproval" }>;
type PermissionsRequest = Extract<ServerRequest, { method: "item/permissions/requestApproval" }>;
type QuestionsRequest = Extract<ServerRequest, { method: "item/tool/requestUserInput" }>;
type McpRequest = Extract<ServerRequest, { method: "mcpServer/elicitation/request" }>;
type LegacyPatchRequest = Extract<ServerRequest, { method: "applyPatchApproval" }>;
type LegacyCommandRequest = Extract<ServerRequest, { method: "execCommandApproval" }>;

interface Confirmation {
  readonly label: string;
  readonly response: unknown;
}

export interface ApprovalPanelProps {
  readonly pending: readonly PendingInteraction[];
  readonly resolvedElsewhereCount: number;
  readonly onOpenLink?: (url: string) => void;
  readonly onRespond: (key: string, response: unknown) => boolean;
}

export function ApprovalPanel({
  pending,
  resolvedElsewhereCount,
  onOpenLink,
  onRespond,
}: ApprovalPanelProps) {
  const current = pending[0] ?? null;
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  useEffect(() => {
    setAnswers(current === null ? {} : initialAnswers(current.request));
    setConfirmation(null);
  }, [current?.key]);

  if (current === null) return null;

  const respond = (response: unknown) => {
    setConfirmation(null);
    onRespond(current.key, response);
  };
  const confirmSession = (label: string, response: unknown) => {
    setConfirmation({ label, response });
  };

  return (
    <section
      aria-label="待处理请求"
      aria-live="assertive"
      className={styles.panel}
      data-responding={current.responding}
    >
      <header>
        <span className={styles.attention} aria-hidden="true" />
        <div>
          <strong>{requestTitle(current.request)}</strong>
          <small>
            {current.responding
              ? "正在提交处理结果"
              : pending.length > 1
                ? `当前请求后还有 ${pending.length - 1} 项`
                : "Codex 正在等待你的决定"}
          </small>
        </div>
      </header>

      {resolvedElsewhereCount > 0 ? (
        <p className={styles.otherWindow} role="status">有请求已在其他窗口处理</p>
      ) : null}

      <RequestContent
        answers={answers}
        disabled={current.responding}
        onAnswersChange={setAnswers}
        onConfirmSession={confirmSession}
        onOpenLink={onOpenLink}
        onRespond={respond}
        request={current.request}
      />

      {confirmation === null ? null : (
        <div className={styles.confirmation} role="alertdialog" aria-label="确认长期授权">
          <strong>确认扩大授权范围</strong>
          <p>{confirmation.label}。该决定会影响后续操作，请确认作用域符合预期</p>
          <div className={styles.actions}>
            <button disabled={current.responding} onClick={() => setConfirmation(null)} type="button">返回</button>
            <button className={styles.dangerAction} disabled={current.responding} onClick={() => respond(confirmation.response)} type="button">确认授权</button>
          </div>
        </div>
      )}
    </section>
  );
}

function RequestContent({
  answers,
  disabled,
  onAnswersChange,
  onConfirmSession,
  onOpenLink,
  onRespond,
  request,
}: {
  readonly answers: Record<string, unknown>;
  readonly disabled: boolean;
  readonly onAnswersChange: (answers: Record<string, unknown>) => void;
  readonly onConfirmSession: (label: string, response: unknown) => void;
  readonly onOpenLink?: ((url: string) => void) | undefined;
  readonly onRespond: (response: unknown) => void;
  readonly request: ServerRequest;
}) {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return <CommandApproval disabled={disabled} onConfirmSession={onConfirmSession} onRespond={onRespond} request={request} />;
    case "item/fileChange/requestApproval":
      return <FileApproval disabled={disabled} onConfirmSession={onConfirmSession} onRespond={onRespond} request={request} />;
    case "item/permissions/requestApproval":
      return <PermissionsApproval disabled={disabled} onConfirmSession={onConfirmSession} onRespond={onRespond} request={request} />;
    case "item/tool/requestUserInput":
      return <QuestionsForm answers={answers} disabled={disabled} onAnswersChange={onAnswersChange} onRespond={onRespond} request={request} />;
    case "mcpServer/elicitation/request":
      return <McpForm answers={answers} disabled={disabled} onAnswersChange={onAnswersChange} onOpenLink={onOpenLink} onRespond={onRespond} request={request} />;
    case "applyPatchApproval":
      return <LegacyPatchApproval disabled={disabled} onConfirmSession={onConfirmSession} onRespond={onRespond} request={request} />;
    case "execCommandApproval":
      return <LegacyCommandApproval disabled={disabled} onConfirmSession={onConfirmSession} onRespond={onRespond} request={request} />;
    default:
      return null;
  }
}

function CommandApproval({ disabled, onConfirmSession, onRespond, request }: ApprovalProps<CommandRequest>) {
  const { params } = request;
  const supportsSession = params.availableDecisions?.includes("acceptForSession") === true;
  return (
    <>
      {params.reason ? <p className={styles.reason}>{params.reason}</p> : null}
      <Detail label="命令"><code>{params.command ?? "未提供命令摘要"}</code></Detail>
      {params.cwd ? <Detail label="工作目录"><code>{params.cwd}</code></Detail> : null}
      {params.networkApprovalContext ? <Detail label="网络访问"><code>{params.networkApprovalContext.protocol}://{params.networkApprovalContext.host}</code></Detail> : null}
      <PermissionSummary permissions={params.additionalPermissions} />
      <ApprovalActions
        disabled={disabled}
        onAllow={() => onRespond({ decision: "accept" })}
        onDecline={() => onRespond({ decision: "decline" })}
        {...(supportsSession ? { onAllowSession: () => onConfirmSession("允许本次连接会话中的同类命令", { decision: "acceptForSession" }) } : {})}
      />
    </>
  );
}

function FileApproval({ disabled, onConfirmSession, onRespond, request }: ApprovalProps<FileRequest>) {
  return (
    <>
      {request.params.reason ? <p className={styles.reason}>{request.params.reason}</p> : null}
      <Detail label="文件范围"><code>{request.params.grantRoot ?? "当前变更涉及的文件"}</code></Detail>
      <ApprovalActions
        disabled={disabled}
        onAllow={() => onRespond({ decision: "accept" })}
        onAllowSession={() => onConfirmSession("允许本次连接会话在该范围内继续修改文件", { decision: "acceptForSession" })}
        onDecline={() => onRespond({ decision: "decline" })}
      />
    </>
  );
}

function PermissionsApproval({ disabled, onConfirmSession, onRespond, request }: ApprovalProps<PermissionsRequest>) {
  const response = { permissions: request.params.permissions, scope: "turn" };
  return (
    <>
      {request.params.reason ? <p className={styles.reason}>{request.params.reason}</p> : null}
      <Detail label="工作目录"><code>{request.params.cwd}</code></Detail>
      <PermissionSummary permissions={request.params.permissions} />
      <ApprovalActions
        disabled={disabled}
        onAllow={() => onRespond(response)}
        onAllowSession={() => onConfirmSession("允许本次连接会话持续使用这些额外权限", { ...response, scope: "session" })}
        onDecline={() => onRespond({ permissions: {}, scope: "turn" })}
      />
    </>
  );
}

function QuestionsForm({ answers, disabled, onAnswersChange, onRespond, request }: FormProps<QuestionsRequest>) {
  const complete = request.params.questions.every(({ id }) => String(answers[id] ?? "").trim().length > 0);
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!complete) return;
      onRespond({
        answers: Object.fromEntries(request.params.questions.map(({ id }) => [id, { answers: [String(answers[id])] }])),
      });
    }}>
      <div className={styles.formFields}>
        {request.params.questions.map((question) => (
          <fieldset key={question.id}>
            <legend><span>{question.header}</span><strong>{question.question}</strong></legend>
            {question.options?.map((option) => (
              <label className={styles.option} key={option.label}>
                <input
                  checked={answers[question.id] === option.label}
                  disabled={disabled}
                  name={question.id}
                  onChange={() => onAnswersChange({ ...answers, [question.id]: option.label })}
                  type="radio"
                />
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
              </label>
            ))}
            {question.isOther || question.options == null ? (
              <input
                aria-label={`${question.header}的回答`}
                disabled={disabled}
                onChange={(event) => onAnswersChange({ ...answers, [question.id]: event.target.value })}
                placeholder={question.isOther ? "其他回答" : "输入回答"}
                type={question.isSecret ? "password" : "text"}
                value={typeof answers[question.id] === "string" && !question.options?.some(({ label }) => label === answers[question.id]) ? String(answers[question.id]) : ""}
              />
            ) : null}
          </fieldset>
        ))}
      </div>
      <div className={styles.actions}>
        <button disabled={disabled} onClick={() => onRespond({ answers: {} })} type="button">拒绝回答</button>
        <button className={styles.primaryAction} disabled={disabled || !complete} type="submit">提交回答</button>
      </div>
    </form>
  );
}

function McpForm({ answers, disabled, onAnswersChange, onOpenLink, onRespond, request }: FormProps<McpRequest> & { readonly onOpenLink?: ((url: string) => void) | undefined }) {
  const { params } = request;
  if (params.mode === "url") {
    return (
      <>
        <p className={styles.reason}>{params.message}</p>
        <Detail label={`来自 ${params.serverName}`}><code>{params.url}</code></Detail>
        <div className={styles.actions}>
          <button disabled={disabled} onClick={() => onRespond({ action: "decline", content: null, _meta: null })} type="button">拒绝</button>
          {onOpenLink ? <button disabled={disabled} onClick={() => onOpenLink(params.url)} type="button">查看链接</button> : null}
          <button className={styles.primaryAction} disabled={disabled} onClick={() => onRespond({ action: "accept", content: null, _meta: null })} type="button">确认完成</button>
        </div>
      </>
    );
  }
  if (params.mode === "openai/form") {
    return (
      <>
        <p className={styles.reason}>{params.message}</p>
        <p className={styles.unsupported}>此服务器请求了当前客户端无法安全呈现的专用表单</p>
        <div className={styles.actions}><button disabled={disabled} onClick={() => onRespond({ action: "decline", content: null, _meta: null })} type="button">拒绝</button></div>
      </>
    );
  }
  const entries = Object.entries(params.requestedSchema.properties).filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== undefined);
  const required = new Set(params.requestedSchema.required ?? []);
  const complete = entries.every(([name]) => !required.has(name) || hasMcpValue(answers[name]));
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (complete) onRespond({ action: "accept", content: answers, _meta: null });
    }}>
      <p className={styles.reason}>{params.message}</p>
      <div className={styles.formFields}>
        {entries.map(([name, schema]) => (
          <McpField
            disabled={disabled}
            key={name}
            name={name}
            onChange={(value) => onAnswersChange({ ...answers, [name]: value })}
            required={required.has(name)}
            schema={schema}
            value={answers[name]}
          />
        ))}
      </div>
      <div className={styles.actions}>
        <button disabled={disabled} onClick={() => onRespond({ action: "decline", content: null, _meta: null })} type="button">拒绝</button>
        <button className={styles.primaryAction} disabled={disabled || !complete} type="submit">提交给 {params.serverName}</button>
      </div>
    </form>
  );
}

function McpField({ disabled, name, onChange, required, schema, value }: { readonly disabled: boolean; readonly name: string; readonly onChange: (value: unknown) => void; readonly required: boolean; readonly schema: NonNullable<Extract<McpRequest["params"], { mode: "form" }>["requestedSchema"]["properties"][string]>; readonly value: unknown }) {
  const title = schema.title ?? name;
  if (schema.type === "boolean") {
    return <label className={styles.checkField}><input checked={value === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} type="checkbox" /><span>{title}{required ? "（必填）" : ""}</span></label>;
  }
  if (schema.type === "array") {
    const options = "enum" in schema.items ? schema.items.enum.map((item) => ({ label: item, value: item })) : schema.items.anyOf.map((item) => ({ label: item.title, value: item.const }));
    const selected = Array.isArray(value) ? value : [];
    return <fieldset><legend><strong>{title}{required ? "（必填）" : ""}</strong></legend>{options.map((option) => <label className={styles.option} key={option.value}><input checked={selected.includes(option.value)} disabled={disabled} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} type="checkbox" /><span><strong>{option.label}</strong></span></label>)}</fieldset>;
  }
  const enumOptions = "enum" in schema ? schema.enum.map((item, index) => ({ label: ("enumNames" in schema ? schema.enumNames?.[index] : undefined) ?? item, value: item })) : "oneOf" in schema ? schema.oneOf.map((item) => ({ label: item.title, value: item.const })) : null;
  if (enumOptions !== null) {
    return <label className={styles.field}><span>{title}{required ? "（必填）" : ""}</span><select disabled={disabled} onChange={(event) => onChange(event.target.value)} required={required} value={typeof value === "string" ? value : ""}><option value="">请选择</option>{enumOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
  }
  const format = "format" in schema ? schema.format : null;
  return <label className={styles.field}><span>{title}{required ? "（必填）" : ""}</span><input disabled={disabled} max={"maximum" in schema ? schema.maximum ?? undefined : undefined} min={"minimum" in schema ? schema.minimum ?? undefined : undefined} onChange={(event) => onChange(schema.type === "number" || schema.type === "integer" ? event.target.valueAsNumber : event.target.value)} required={required} type={schema.type === "number" || schema.type === "integer" ? "number" : format === "email" ? "email" : format === "date" ? "date" : "text"} value={typeof value === "number" || typeof value === "string" ? value : ""} />{schema.description ? <small>{schema.description}</small> : null}</label>;
}

function LegacyPatchApproval({ disabled, onConfirmSession, onRespond, request }: ApprovalProps<LegacyPatchRequest>) {
  const paths = Object.keys(request.params.fileChanges);
  return <>{request.params.reason ? <p className={styles.reason}>{request.params.reason}</p> : null}<Detail label="变更文件"><code>{paths.join("\n") || "未提供文件列表"}</code></Detail>{request.params.grantRoot ? <Detail label="请求范围"><code>{request.params.grantRoot}</code></Detail> : null}<ApprovalActions disabled={disabled} onAllow={() => onRespond({ decision: "approved" })} onAllowSession={() => onConfirmSession("允许本次连接会话继续修改文件", { decision: "approved_for_session" })} onDecline={() => onRespond({ decision: "denied" })} /></>;
}

function LegacyCommandApproval({ disabled, onConfirmSession, onRespond, request }: ApprovalProps<LegacyCommandRequest>) {
  return <>{request.params.reason ? <p className={styles.reason}>{request.params.reason}</p> : null}<Detail label="命令"><code>{request.params.command.join(" ")}</code></Detail><Detail label="工作目录"><code>{request.params.cwd}</code></Detail><ApprovalActions disabled={disabled} onAllow={() => onRespond({ decision: "approved" })} onAllowSession={() => onConfirmSession("允许本次连接会话中的同类命令", { decision: "approved_for_session" })} onDecline={() => onRespond({ decision: "denied" })} /></>;
}

function ApprovalActions({ disabled, onAllow, onAllowSession, onDecline }: { readonly disabled: boolean; readonly onAllow: () => void; readonly onAllowSession?: (() => void) | undefined; readonly onDecline: () => void }) {
  return <div className={styles.actions}><button disabled={disabled} onClick={onDecline} type="button">拒绝</button>{onAllowSession ? <button disabled={disabled} onClick={onAllowSession} type="button">本次会话允许</button> : null}<button className={styles.primaryAction} disabled={disabled} onClick={onAllow} type="button">允许一次</button></div>;
}

function Detail({ children, label }: { readonly children: React.ReactNode; readonly label: string }) {
  return <div className={styles.detail}><span>{label}</span>{children}</div>;
}

function PermissionSummary({ permissions }: { readonly permissions: CommandRequest["params"]["additionalPermissions"] | PermissionsRequest["params"]["permissions"] }) {
  if (!permissions) return null;
  const entries = permissions.fileSystem?.entries ?? [];
  const legacyRead = permissions.fileSystem?.read ?? [];
  const legacyWrite = permissions.fileSystem?.write ?? [];
  if (entries.length === 0 && legacyRead.length === 0 && legacyWrite.length === 0 && permissions.network?.enabled !== true) return null;
  return <div className={styles.permissions}><span>额外权限</span><ul>{entries.map((entry, index) => <li key={`${entry.access}:${index}`}>{permissionLabel(entry.access)} <code>{fileSystemPath(entry.path)}</code></li>)}{legacyRead.map((path) => <li key={`read:${path}`}>读取 <code>{path}</code></li>)}{legacyWrite.map((path) => <li key={`write:${path}`}>写入 <code>{path}</code></li>)}{permissions.network?.enabled === true ? <li>访问网络</li> : null}</ul></div>;
}

function requestTitle(request: ServerRequest): string {
  switch (request.method) {
    case "item/commandExecution/requestApproval": case "execCommandApproval": return "命令需要审批";
    case "item/fileChange/requestApproval": case "applyPatchApproval": return "文件修改需要审批";
    case "item/permissions/requestApproval": return "请求额外权限";
    case "item/tool/requestUserInput": return "Codex 需要你的回答";
    case "mcpServer/elicitation/request": return "外部工具需要输入";
    default: return "待处理请求";
  }
}

function initialAnswers(request: ServerRequest): Record<string, unknown> {
  if (request.method !== "mcpServer/elicitation/request" || request.params.mode !== "form") return {};
  return Object.fromEntries(Object.entries(request.params.requestedSchema.properties).flatMap(([name, schema]) => schema?.default == null ? [] : [[name, schema.default]]));
}

function hasMcpValue(value: unknown): boolean {
  return typeof value === "boolean" || typeof value === "number" || (typeof value === "string" && value.trim().length > 0) || (Array.isArray(value) && value.length > 0);
}

function fileSystemPath(path: NonNullable<NonNullable<PermissionsRequest["params"]["permissions"]["fileSystem"]>["entries"]>[number]["path"]): string {
  switch (path.type) {
    case "path": return path.path;
    case "glob_pattern": return path.pattern;
    case "special": return path.value.kind === "unknown" ? path.value.path : `${path.value.kind}${path.value.subpath ? `/${path.value.subpath}` : ""}`;
  }
}

function permissionLabel(access: "read" | "write" | "deny"): string {
  return access === "read" ? "读取" : access === "write" ? "写入" : "禁止";
}

interface ApprovalProps<T extends ServerRequest> {
  readonly disabled: boolean;
  readonly onConfirmSession: (label: string, response: unknown) => void;
  readonly onRespond: (response: unknown) => void;
  readonly request: T;
}

interface FormProps<T extends ServerRequest> {
  readonly answers: Record<string, unknown>;
  readonly disabled: boolean;
  readonly onAnswersChange: (answers: Record<string, unknown>) => void;
  readonly onRespond: (response: unknown) => void;
  readonly request: T;
}
