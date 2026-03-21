"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { useApi } from "../../hooks/use-api";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "../ui/admin-table";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "../ui/dialog";
import { FormField } from "../ui/form-field";
import { Skeleton } from "../ui/skeleton";

interface McpServer {
  id: string;
  name: string;
  slug: string;
  description: string;
  logo_url: string | null;
  base_url: string;
  mcp_endpoint_path: string;
  client_id: string | null;
  created_at: string;
  connection_count: number;
  active_count: number;
}

export interface McpServerListPageProps {
  initialData?: McpServer[];
}

const emptyForm = { name: "", slug: "", description: "", base_url: "", mcp_endpoint_path: "/mcp" };

export function McpServerListPage({ initialData }: McpServerListPageProps) {
  const { mutate } = useSWRConfig();
  const client = useAgentPlaneClient();

  const { data: servers, error, isLoading } = useApi<McpServer[]>(
    "mcp-servers",
    (c) => c.customConnectors.listServers() as Promise<McpServer[]>,
    initialData ? { fallbackData: initialData } : undefined,
  );

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState(emptyForm);
  const [createError, setCreateError] = useState("");

  // Edit modal
  const [editTarget, setEditTarget] = useState<McpServer | null>(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", description: "" });
  const [editError, setEditError] = useState("");

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  async function handleCreate() {
    setCreating(true);
    setCreateError("");
    try {
      await client.customConnectors.createServer!(createForm);
      setShowCreate(false);
      setCreateForm(emptyForm);
      mutate("mcp-servers");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setCreating(false);
    }
  }

  function openEdit(server: McpServer) {
    setEditTarget(server);
    setEditForm({ name: server.name, description: server.description });
    setEditError("");
  }

  async function handleEdit() {
    if (!editTarget) return;
    setEditing(true);
    setEditError("");
    try {
      await client.customConnectors.updateServer!(editTarget.id, editForm);
      setEditTarget(null);
      mutate("mcp-servers");
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setEditing(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await client.customConnectors.deleteServer!(deleteTarget.id);
      setDeleteTarget(null);
      mutate("mcp-servers");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeleting(false);
    }
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-destructive">Failed to load connectors: {error.message}</p>
      </div>
    );
  }

  if (isLoading || !servers) {
    return <Skeleton className="h-96 rounded-lg" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center">
        <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
          + New Connector
        </Button>
      </div>

      <AdminTable>
        <AdminTableHead>
          <Th>Name</Th>
          <Th>Slug</Th>
          <Th>Base URL</Th>
          <Th>OAuth</Th>
          <Th align="right">Connections</Th>
          <Th align="right">Active</Th>
          <Th>Created</Th>
          <Th align="right" />
        </AdminTableHead>
        <tbody>
          {servers.map((s) => (
            <AdminTableRow key={s.id}>
              <td className="p-3">
                <button
                  onClick={() => openEdit(s)}
                  className="flex items-center gap-2 text-left hover:underline cursor-pointer"
                >
                  {s.logo_url && (
                    <img src={s.logo_url} alt="" className="w-5 h-5 rounded-sm object-contain" />
                  )}
                  <span className="font-medium text-primary">{s.name}</span>
                </button>
              </td>
              <td className="p-3 font-mono text-xs text-muted-foreground">{s.slug}</td>
              <td className="p-3 font-mono text-xs text-muted-foreground truncate max-w-xs" title={s.base_url}>
                {s.base_url}
              </td>
              <td className="p-3">
                <Badge variant={s.client_id ? "default" : "secondary"}>
                  {s.client_id ? "Registered" : "No DCR"}
                </Badge>
              </td>
              <td className="p-3 text-right">{s.connection_count}</td>
              <td className="p-3 text-right text-green-500">{s.active_count}</td>
              <td className="p-3 text-muted-foreground text-xs">
                {new Date(s.created_at).toLocaleDateString()}
              </td>
              <td className="p-3 text-right">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={s.connection_count > 0}
                  onClick={() => setDeleteTarget(s)}
                >
                  Delete
                </Button>
              </td>
            </AdminTableRow>
          ))}
          {servers.length === 0 && (
            <EmptyRow colSpan={8}>
              No custom connectors registered. Click &quot;+ New Connector&quot; to add one.
            </EmptyRow>
          )}
        </tbody>
      </AdminTable>

      {/* Create Modal */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Register Connector</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {createError && <p className="text-sm text-destructive">{createError}</p>}
            <FormField label="Name">
              <Input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} placeholder="My MCP Server" />
            </FormField>
            <FormField label="Slug">
              <Input value={createForm.slug} onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value })} placeholder="my-mcp-server" />
            </FormField>
            <FormField label="Description">
              <Input value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} placeholder="What this connector does" />
            </FormField>
            <FormField label="Base URL">
              <Input value={createForm.base_url} onChange={(e) => setCreateForm({ ...createForm, base_url: e.target.value })} placeholder="https://my-server.example.com" />
            </FormField>
            <FormField label="MCP Endpoint Path">
              <Input value={createForm.mcp_endpoint_path} onChange={(e) => setCreateForm({ ...createForm, mcp_endpoint_path: e.target.value })} placeholder="/mcp" />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !createForm.name || !createForm.base_url}>
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Modal */}
      <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Connector</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {editError && <p className="text-sm text-destructive">{editError}</p>}
            <FormField label="Name">
              <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </FormField>
            <FormField label="Description">
              <Input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
            </FormField>
            {editTarget && (
              <div className="text-xs text-muted-foreground space-y-1">
                <div><span className="font-medium">Slug:</span> {editTarget.slug}</div>
                <div><span className="font-medium">Base URL:</span> {editTarget.base_url}</div>
                <div><span className="font-medium">Endpoint:</span> {editTarget.mcp_endpoint_path}</div>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={editing || !editForm.name}>
              {editing ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteError(""); } }}
        title="Delete Connector"
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        loading={deleting}
        error={deleteError}
        onConfirm={handleDelete}
      >
        Delete connector <span className="font-medium text-foreground">{deleteTarget?.name}</span>? This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}
