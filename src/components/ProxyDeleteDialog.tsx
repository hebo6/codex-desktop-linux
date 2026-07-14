import type { ProxyProfile, ServerProfile } from "../configuration";
import serverStyles from "./ServerEditorDialog.module.css";

export function ProxyDeleteDialog({ proxy, servers, deleting, error, onCancel, onConfirm }: { readonly proxy: ProxyProfile | null; readonly servers: readonly ServerProfile[]; readonly deleting: boolean; readonly error: string | null; readonly onCancel: () => void; readonly onConfirm: (proxy: ProxyProfile) => void }) {
  if (proxy === null) return null;
  const referenced = servers.filter((server) => server.configuration.type === "remoteWebSocket" && server.configuration.proxyId === proxy.proxyId);
  return <div className={serverStyles.backdrop}><section aria-labelledby="proxy-delete-title" aria-modal="true" className={serverStyles.dialog} role="alertdialog"><header className={serverStyles.header}><div><h2 id="proxy-delete-title">删除代理</h2><p>此操作只删除本机配置与关联凭据</p></div></header><div className={serverStyles.body}><p>确定删除“{proxy.name}”吗？</p>{referenced.length > 0 ? <div className={serverStyles.submitError} role="alert">代理仍被以下服务器引用：{referenced.map(({ name }) => name).join("、")}。请先编辑这些服务器并改为直连或其他代理</div> : null}{error ? <div className={serverStyles.submitError} role="alert">{error}</div> : null}</div><footer className={serverStyles.footer}><button className={serverStyles.secondaryButton} disabled={deleting} onClick={onCancel} type="button">取消</button><button className={serverStyles.primaryButton} disabled={deleting || referenced.length > 0} onClick={() => onConfirm(proxy)} type="button">{deleting ? "正在删除" : "确认删除"}</button></footer></section></div>;
}
