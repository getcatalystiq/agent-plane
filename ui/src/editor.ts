// Separate entry point for CodeMirror-based components.
// Import from "@getcatalystiq/agent-plane-ui/editor" to use these.
// Keeps CodeMirror ~120KB out of the core bundle.

export { FileTreeEditor } from "./components/editor/file-tree-editor";
export type { FileTreeEditorProps, FlatFile } from "./components/editor/file-tree-editor";

export { PluginEditorPage } from "./components/editor/plugin-editor-page";
export type { PluginEditorPageProps } from "./components/editor/plugin-editor-page";

export { AgentIdentityTab } from "./components/pages/agent-identity-tab";
export type { AgentIdentityTabProps } from "./components/pages/agent-identity-tab";
