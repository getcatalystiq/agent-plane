// Types
export type {
  AgentPlaneClient,
  LinkComponentProps,
  NavigationProps,
  AgentPlaneProviderProps,
  PlaygroundStream,
  PlaygroundStreamEvent,
} from "./types";

// Provider
export { AgentPlaneProvider } from "./provider";

// Hooks
export {
  useAgentPlaneClient,
  useAuthError,
  useNavigation,
  useApi,
} from "./hooks";

// Utilities
export { cn } from "./utils";

// UI Primitives
export { Button, buttonVariants } from "./components/ui/button";
export type { ButtonProps } from "./components/ui/button";

export { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./components/ui/card";

export { Badge, badgeVariants } from "./components/ui/badge";
export type { BadgeProps } from "./components/ui/badge";

export { Input } from "./components/ui/input";

export { Select } from "./components/ui/select";

export { Textarea } from "./components/ui/textarea";
export type { TextareaProps } from "./components/ui/textarea";

export { FormField } from "./components/ui/form-field";

export { FormError } from "./components/ui/form-error";

export { SectionHeader } from "./components/ui/section-header";

export { DetailPageHeader } from "./components/ui/detail-page-header";

export { Skeleton } from "./components/ui/skeleton";

export { MetricCard } from "./components/ui/metric-card";

export { AdminTable, AdminTableHead, Th, AdminTableRow, EmptyRow } from "./components/ui/admin-table";

export { PaginationBar, parsePaginationParams } from "./components/ui/pagination-bar";

export { Tabs } from "./components/ui/tabs";

export { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription } from "./components/ui/dialog";

export { ConfirmDialog } from "./components/ui/confirm-dialog";

export { CopyButton } from "./components/ui/copy-button";

export { RunStatusBadge } from "./components/ui/run-status-badge";

export { RunSourceBadge } from "./components/ui/run-source-badge";

export { LocalDate } from "./components/ui/local-date";

// Page Components
export { DashboardPage } from "./components/pages/dashboard-page";
export type { DashboardPageProps } from "./components/pages/dashboard-page";

export { RunListPage } from "./components/pages/run-list-page";
export type { RunListPageProps } from "./components/pages/run-list-page";

export { RunDetailPage } from "./components/pages/run-detail-page";
export type { RunDetailPageProps } from "./components/pages/run-detail-page";

export { TranscriptViewer } from "./components/pages/transcript-viewer";

export { McpServerListPage } from "./components/pages/mcp-server-list-page";
export type { McpServerListPageProps } from "./components/pages/mcp-server-list-page";

export { PluginMarketplaceListPage } from "./components/pages/plugin-marketplace-list-page";
export type { PluginMarketplaceListPageProps } from "./components/pages/plugin-marketplace-list-page";

export { PluginMarketplaceDetailPage } from "./components/pages/plugin-marketplace-detail-page";
export type { PluginMarketplaceDetailPageProps } from "./components/pages/plugin-marketplace-detail-page";

export { PluginDetailPage } from "./components/pages/plugin-detail-page";
export type { PluginDetailPageProps } from "./components/pages/plugin-detail-page";

// Note: PluginEditorPage (full CodeMirror-based editor) is exported from
// "@getcatalystiq/agent-plane-ui/editor" to keep CodeMirror out of the core bundle.

export { SettingsPage } from "./components/pages/settings-page";
export type { SettingsPageProps } from "./components/pages/settings-page";

export { AgentListPage } from "./components/pages/agent-list-page";

export { AgentDetailPage } from "./components/pages/agent-detail-page";

export { AgentEditForm } from "./components/pages/agent-edit-form";

export { AgentConnectorsManager } from "./components/pages/agent-connectors-manager";

export { AgentSkillManager } from "./components/pages/agent-skill-manager";

export { AgentPluginManager } from "./components/pages/agent-plugin-manager";

export { AgentScheduleForm } from "./components/pages/agent-schedule-form";

export { AgentRuns } from "./components/pages/agent-runs";

export { AgentA2aInfo } from "./components/pages/agent-a2a-info";

export { PlaygroundPage } from "./components/pages/playground-page";
export type { PlaygroundPageProps } from "./components/pages/playground-page";

// UI Components (extracted for agent pages)
export { ModelSelector } from "./components/ui/model-selector";

export { ToolkitMultiselect } from "./components/ui/toolkit-multiselect";
