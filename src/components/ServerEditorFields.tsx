import type { RefCallback } from "react";

import type {
  KeyValueDraft,
  ServerEditorFieldErrors,
  ServerEditorFieldName,
} from "./serverEditorModel";
import styles from "./ServerEditorDialog.module.css";

export interface ServerEditorFieldSupport {
  readonly fieldErrors: ServerEditorFieldErrors;
  readonly fieldId: (field: ServerEditorFieldName) => string;
  readonly errorId: (field: ServerEditorFieldName) => string;
  readonly clearFieldError: (field: ServerEditorFieldName) => void;
  readonly registerField: (
    field: ServerEditorFieldName,
  ) => RefCallback<HTMLElement>;
}

export function FieldError({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}) {
  if (message === undefined) {
    return null;
  }
  return (
    <span className={styles.fieldError} id={id} role="alert">
      {message}
    </span>
  );
}

interface ArgumentListProps {
  readonly values: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
  readonly support: ServerEditorFieldSupport;
}

export function ArgumentList({ values, onChange, support }: ArgumentListProps) {
  const field = "arguments";
  const error = support.fieldErrors[field];
  const describedBy = `${support.fieldId(field)}-help${
    error === undefined ? "" : ` ${support.errorId(field)}`
  }`;

  return (
    <fieldset className={styles.fieldGroup}>
      <legend>参数</legend>
      <div className={styles.list}>
        {values.map((value, index) => (
          <div className={styles.argumentRow} key={index}>
            <label htmlFor={`${support.fieldId(field)}-${index}`}>
              参数 {index + 1}
            </label>
            <textarea
              aria-describedby={describedBy}
              aria-invalid={error !== undefined}
              id={`${support.fieldId(field)}-${index}`}
              onChange={(event) => {
                const next = [...values];
                next[index] = event.target.value;
                onChange(next);
                support.clearFieldError(field);
              }}
              ref={index === 0 ? support.registerField(field) : undefined}
              rows={2}
              spellCheck={false}
              value={value}
            />
            <button
              aria-label={`删除参数 ${index + 1}`}
              className={styles.removeButton}
              onClick={() => {
                onChange(
                  values.filter((_, valueIndex) => valueIndex !== index),
                );
                support.clearFieldError(field);
              }}
              type="button"
            >
              删除
            </button>
          </div>
        ))}
      </div>
      <button
        className={styles.addButton}
        onClick={() => {
          onChange([...values, ""]);
          support.clearFieldError(field);
        }}
        ref={values.length === 0 ? support.registerField(field) : undefined}
        type="button"
      >
        添加参数
      </button>
      <small id={`${support.fieldId(field)}-help`}>
        每项对应一个原始参数；空文本表示空字符串参数，换行会保留
      </small>
      <FieldError id={support.errorId(field)} message={error} />
    </fieldset>
  );
}

interface KeyValueListProps {
  readonly field: Extract<
    ServerEditorFieldName,
    "nonSensitiveEnvironment" | "sensitiveEnvironment" | "nonSensitiveHeaders"
  >;
  readonly label: string;
  readonly help: string;
  readonly namePlaceholder: string;
  readonly valuePlaceholder: string;
  readonly values: readonly KeyValueDraft[];
  readonly onChange: (values: readonly KeyValueDraft[]) => void;
  readonly support: ServerEditorFieldSupport;
  readonly credentialErrorId?: string;
  readonly sensitive?: boolean;
}

export function KeyValueList({
  field,
  label,
  help,
  namePlaceholder,
  valuePlaceholder,
  values,
  onChange,
  support,
  credentialErrorId,
  sensitive = false,
}: KeyValueListProps) {
  const error = support.fieldErrors[field];
  const invalid = error !== undefined || credentialErrorId !== undefined;
  const describedBy = [
    `${support.fieldId(field)}-help`,
    error === undefined ? undefined : support.errorId(field),
    credentialErrorId,
  ]
    .filter(Boolean)
    .join(" ");

  const updateEntry = (index: number, patch: Partial<KeyValueDraft>) => {
    const next = values.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, ...patch } : entry,
    );
    onChange(next);
    support.clearFieldError(field);
    support.clearFieldError("credential");
  };

  return (
    <fieldset className={styles.fieldGroup}>
      <legend>{label}</legend>
      <div className={styles.list}>
        {values.map((entry, index) => (
          <div className={styles.keyValueRow} key={index}>
            <label htmlFor={`${support.fieldId(field)}-${index}-name`}>
              {label}名称 {index + 1}
            </label>
            <input
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
              id={`${support.fieldId(field)}-${index}-name`}
              onChange={(event) =>
                updateEntry(index, { name: event.target.value })
              }
              placeholder={namePlaceholder}
              ref={index === 0 ? support.registerField(field) : undefined}
              spellCheck={false}
              value={entry.name}
            />
            <label htmlFor={`${support.fieldId(field)}-${index}-value`}>
              {label}值 {index + 1}
            </label>
            <textarea
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete={sensitive ? "off" : undefined}
              id={`${support.fieldId(field)}-${index}-value`}
              onChange={(event) =>
                updateEntry(index, { value: event.target.value })
              }
              placeholder={valuePlaceholder}
              rows={2}
              spellCheck={false}
              value={entry.value}
            />
            <button
              aria-label={`删除${label} ${index + 1}`}
              className={styles.removeButton}
              onClick={() => {
                onChange(
                  values.filter((_, valueIndex) => valueIndex !== index),
                );
                support.clearFieldError(field);
                support.clearFieldError("credential");
              }}
              type="button"
            >
              删除
            </button>
          </div>
        ))}
      </div>
      <button
        className={styles.addButton}
        onClick={() => {
          onChange([...values, { name: "", value: "" }]);
          support.clearFieldError(field);
          support.clearFieldError("credential");
        }}
        ref={values.length === 0 ? support.registerField(field) : undefined}
        type="button"
      >
        添加{label}
      </button>
      <small id={`${support.fieldId(field)}-help`}>{help}</small>
      <FieldError id={support.errorId(field)} message={error} />
    </fieldset>
  );
}
