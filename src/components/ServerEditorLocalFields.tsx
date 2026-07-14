import type { ReactNode } from "react";

import { ArgumentList, FieldError, KeyValueList } from "./ServerEditorFields";
import type { ServerEditorFieldSupport } from "./ServerEditorFields";
import type { LocalDraft } from "./serverEditorModel";
import styles from "./ServerEditorDialog.module.css";

interface ServerEditorLocalFieldsProps {
  readonly draft: LocalDraft;
  readonly onChange: (patch: Partial<LocalDraft>) => void;
  readonly onSensitiveInput: () => void;
  readonly credentialStatus: ReactNode;
  readonly support: ServerEditorFieldSupport;
}

export function ServerEditorLocalFields({
  draft,
  onChange,
  onSensitiveInput,
  credentialStatus,
  support,
}: ServerEditorLocalFieldsProps) {
  return (
    <section aria-label="本机 stdio 配置" className={styles.section}>
      <div className={styles.sectionHeading}>
        <h3>进程</h3>
        <p>命令由客户端直接启动，不经过 Shell</p>
      </div>

      <label
        className={styles.field}
        htmlFor={support.fieldId("executablePath")}
      >
        <span>可执行文件路径</span>
        <input
          aria-describedby={
            support.fieldErrors.executablePath === undefined
              ? `${support.fieldId("executablePath")}-help`
              : `${support.fieldId("executablePath")}-help ${support.errorId("executablePath")}`
          }
          aria-invalid={support.fieldErrors.executablePath !== undefined}
          id={support.fieldId("executablePath")}
          onChange={(event) => {
            onChange({ executablePath: event.target.value });
            support.clearFieldError("executablePath");
            support.clearFieldError("credential");
          }}
          placeholder="/usr/bin/codex"
          ref={support.registerField("executablePath")}
          spellCheck={false}
          value={draft.executablePath}
        />
        <small id={`${support.fieldId("executablePath")}-help`}>
          必须填写 Linux 绝对路径
        </small>
        <FieldError
          id={support.errorId("executablePath")}
          message={support.fieldErrors.executablePath}
        />
      </label>

      <ArgumentList
        onChange={(values) => onChange({ arguments: values })}
        support={support}
        values={draft.arguments}
      />

      <label
        className={styles.field}
        htmlFor={support.fieldId("defaultWorkingDirectory")}
      >
        <span>默认工作目录</span>
        <input
          aria-describedby={
            support.fieldErrors.defaultWorkingDirectory === undefined
              ? `${support.fieldId("defaultWorkingDirectory")}-help`
              : `${support.fieldId("defaultWorkingDirectory")}-help ${support.errorId("defaultWorkingDirectory")}`
          }
          aria-invalid={
            support.fieldErrors.defaultWorkingDirectory !== undefined
          }
          id={support.fieldId("defaultWorkingDirectory")}
          onChange={(event) => {
            onChange({ defaultWorkingDirectory: event.target.value });
            support.clearFieldError("defaultWorkingDirectory");
          }}
          placeholder="/home/user/project"
          ref={support.registerField("defaultWorkingDirectory")}
          spellCheck={false}
          value={draft.defaultWorkingDirectory}
        />
        <small id={`${support.fieldId("defaultWorkingDirectory")}-help`}>
          可选；连接时仍可由窗口覆盖
        </small>
        <FieldError
          id={support.errorId("defaultWorkingDirectory")}
          message={support.fieldErrors.defaultWorkingDirectory}
        />
      </label>

      <div className={styles.twoColumns}>
        <KeyValueList
          field="nonSensitiveEnvironment"
          help="名称和值分开填写，值中的空白与换行会原样保留；不要填写令牌或密码"
          label="普通环境变量"
          namePlaceholder="CODEX_MODE"
          onChange={(values) => {
            onChange({ nonSensitiveEnvironment: values });
            support.clearFieldError("credential");
          }}
          support={support}
          valuePlaceholder="desktop"
          values={draft.nonSensitiveEnvironment}
        />

        <KeyValueList
          {...(support.fieldErrors.credential === undefined
            ? {}
            : { credentialErrorId: support.errorId("credential") })}
          field="sensitiveEnvironment"
          help="明文不会在编辑时回填；值中的空白与换行会原样保留"
          label="敏感环境变量"
          namePlaceholder="API_TOKEN"
          onChange={(values) => {
            onChange({ sensitiveEnvironment: values });
            if (values.length > 0) {
              onSensitiveInput();
            }
          }}
          sensitive
          support={support}
          valuePlaceholder="敏感值"
          values={draft.sensitiveEnvironment}
        />
      </div>
      {credentialStatus}
      <FieldError
        id={support.errorId("credential")}
        message={support.fieldErrors.credential}
      />
    </section>
  );
}
