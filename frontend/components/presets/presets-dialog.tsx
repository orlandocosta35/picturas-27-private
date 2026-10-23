"use client";

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/providers/session-provider";
import { useProjectInfo, useSetProjectTools } from "@/providers/project-provider";
import { usePresetsQuery } from "@/lib/queries/presets";
import { useCreatePreset } from "@/lib/mutations/presets";
import { useReorderProjectTools } from "@/lib/mutations/projects";
import { useSearchParams } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/error-messages";
import type { PresetTool } from "@/lib/presets";
import { useDeletePreset, useSharePreset, useUpdatePreset } from "@/lib/mutations/presets";
import { Label } from "@/components/ui/label";
import { DialogDescription } from "@/components/ui/dialog";

export function PresetsDialog() {
  const session = useSession();
  const project = useProjectInfo();
  const setTools = useSetProjectTools();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const updatePreset = useUpdatePreset(session.user._id, session.token);
  const deletePreset = useDeletePreset(session.user._id, session.token);
  const sharePreset = useSharePreset(session.user._id, session.token);

  const ownerParam = searchParams.get("owner") ?? session.user._id;
  const shareId = searchParams.get("share") ?? undefined;

  const { data, isLoading } = usePresetsQuery(session.user._id, session.token);
  const createPreset = useCreatePreset(session.user._id, session.token);

  const reorder = useReorderProjectTools(
    session.user._id,
    project._id,
    session.token,
    ownerParam,
    shareId,
  );

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>("");
  const [replaceTools, setReplaceTools] = useState<boolean>(false);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const userCount = data?.userPresets?.length ?? 0;
  const maxReached = userCount >= 4;

  const toolCount = project.tools?.length ?? 0;
  const hasMinTools = toolCount >= 2;
  const canCreate = hasMinTools && !maxReached;

  const createDisabled = createPreset.isPending || !hasMinTools || maxReached;

  const createPlaceholder = !hasMinTools
    ? "Select at least 2 tools to create a preset"
    : maxReached
      ? "Limit of 4 presets reached"
      : "Preset name…";

  const currentToolsForPreset: PresetTool[] = useMemo(() => {
    return project.tools.map((t) => ({ procedure: t.procedure, params: t.params }));
  }, [project.tools]);

  function applyPreset(tools: PresetTool[]) {
    // RNF60: UI update imediata (optimistic)
    const withPositions = tools.map((t, idx) => ({ ...t, position: idx }));
    setTools(withPositions as any);

    reorder.mutate(
      { tools: tools as any, projectVersion: project.version },
      {
        onSuccess: () => {
          toast({ title: "Preset aplicado." });
        },
        onError: (error) => {
          const { title, description } = getErrorMessage("project-update", error);
          toast({ title, description, variant: "destructive" });
        },
      },
    );
  }

  function handleCreate() {
      if (maxReached) {
        toast({
          title: "Limit reached",
          description: "You already have 4 saved presets. Delete one to create another.",
          variant: "destructive",
        });
        return;
      }

      if (!hasMinTools) {
        toast({
          title: "Preset unavailable",
          description: "Select at least 2 tools before saving a preset.",
          variant: "destructive",
        });
        return;
      }

    const trimmed = name.trim();
    if (!trimmed) {
      toast({ title: "Name required", description: "Choose a name for the preset.", variant: "destructive" });
      return;
    }

    createPreset.mutate(
      { name: trimmed, tools: currentToolsForPreset },
      {
        onSuccess: () => {
          toast({ title: "Preset saved." });
          setName("");
        },
        onError: (error: any) => {
          // 409 -> nome duplicado
          const msg = typeof error?.response?.data === "string" ? error.response.data : null;
          toast({
            title: "Could not save preset",
            description: msg ?? "Try a different name.",
            variant: "destructive",
          });
        },
      },
    );
  }

  function openEdit(presetId: string, currentName: string) {
    setEditingId(presetId);
    setEditingName(currentName);
    setReplaceTools(false);
    }

    function confirmEdit() {
    if (!editingId) return;

    const patch: any = {};
    const trimmed = editingName.trim();
    if (trimmed) patch.name = trimmed;
    if (replaceTools) patch.tools = currentToolsForPreset;

    if (Object.keys(patch).length === 0) {
        toast({ title: "Nothing to update." });
        return;
    }

    updatePreset.mutate(
        { presetId: editingId, patch },
        {
        onSuccess: () => {
            toast({ title: "Preset atualizado." });
            setEditingId(null);
        },
        onError: (error: any) => {
            const msg = typeof error?.response?.data === "string" ? error.response.data : "Could not update preset.";
            toast({ title: "Error", description: msg, variant: "destructive" });
        },
        },
    );
    }

    function confirmDelete() {
    if (!deletingId) return;

    deletePreset.mutate(
        { presetId: deletingId },
        {
        onSuccess: () => {
            toast({ title: "Preset eliminado." });
            setDeletingId(null);
        },
        onError: (error: any) => {
            const msg = typeof error?.response?.data === "string" ? error.response.data : "Could not delete preset.";
            toast({ title: "Error", description: msg, variant: "destructive" });
        },
        },
    );
    }

    async function copyShareLink(presetId: string) {
    sharePreset.mutate(
        { presetId },
        {
        onSuccess: async ({ shareId }) => {
            const link = `${window.location.origin}/api-gateway/users/presets/share/${shareId}`;
            try {
            await navigator.clipboard.writeText(link);
            toast({ title: "Link copied." });
            } catch {
            toast({ title: "Link gerado", description: link });
            }
        },
        onError: (error: any) => {
            const msg = typeof error?.response?.data === "string" ? error.response.data : "Could not share preset.";
            toast({ title: "Error", description: msg, variant: "destructive" });
        },
        },
    );
    }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="inline-flex">
            Presets
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Presets</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            placeholder={createPlaceholder}
            value={name}
            disabled={createPreset.isPending || maxReached}  // deixar bloquear só por pending/limite
            onChange={(e) => setName(e.target.value)}
          />
          <Button onClick={handleCreate} disabled={createDisabled}>
            Save
          </Button>
        </div>

        <Tabs defaultValue="defaults" className="mt-4">
          <TabsList>
            <TabsTrigger value="defaults">Built-in presets</TabsTrigger>
            <TabsTrigger value="mine">Meus Filtros</TabsTrigger>
          </TabsList>

          <TabsContent value="defaults" className="space-y-2 mt-3">
            {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {!isLoading && (data?.defaultPresets?.length ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground">No built-in presets.</p>
            )}
          {data?.defaultPresets?.map((p) => (
            <div key={p.id} className="flex items-center justify-between border rounded-md p-2 gap-2">
              <div className="text-sm flex-1 truncate">{p.name}</div>
              <Button size="sm" onClick={() => applyPreset(p.tools)}>
                Apply
              </Button>
            </div>
          ))}

          </TabsContent>

          <TabsContent value="mine" className="space-y-2 mt-3">
            {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {!isLoading && (data?.userPresets?.length ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground">You have no saved presets yet.</p>
            )}
            {data?.userPresets?.map((p) => (
              <div key={p._id} className="flex items-center justify-between border rounded-md p-2 gap-2">
                <div className="text-sm flex-1 truncate">{p.name}</div>

                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => applyPreset(p.tools)}>Apply</Button>
                  <Button size="sm" variant="outline" onClick={() => openEdit(p._id, p.name)}>Edit</Button>
                  <Button size="sm" variant="outline" onClick={() => copyShareLink(p._id)} disabled={sharePreset.isPending}>
                    Share
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeletingId(p._id)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </TabsContent>
        </Tabs>

        <Dialog open={!!editingId} onOpenChange={(v) => !v && setEditingId(null)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                <DialogTitle>Edit preset</DialogTitle>
                <DialogDescription>Update the name or replace the tools.</DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                <div className="grid gap-2">
                    <Label>New name</Label>
                    <Input value={editingName} onChange={(e) => setEditingName(e.target.value)} />
                </div>

                <label className="flex items-center gap-2 text-sm">
                    <input
                    type="checkbox"
                    checked={replaceTools}
                    onChange={(e) => setReplaceTools(e.target.checked)}
                    />
                    Replace tools with the current project tools
                </label>

                <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setEditingId(null)}>
                    Cancel
                    </Button>
                    <Button onClick={confirmEdit} disabled={updatePreset.isPending}>
                    Save
                    </Button>
                </div>
                </div>
            </DialogContent>
            </Dialog>

            <Dialog open={!!deletingId} onOpenChange={(v) => !v && setDeletingId(null)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                <DialogTitle>Eliminar preset</DialogTitle>
                <DialogDescription>This action cannot be undone.</DialogDescription>
                </DialogHeader>

                <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeletingId(null)}>
                    Cancel
                </Button>
                <Button variant="destructive" onClick={confirmDelete} disabled={deletePreset.isPending}>
                    Eliminar
                </Button>
                </div>
            </DialogContent>
            </Dialog>

      </DialogContent>
    </Dialog>
  );
}
