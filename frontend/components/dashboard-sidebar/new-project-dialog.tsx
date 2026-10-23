import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "../ui/label";
import { Input } from "../ui/input";
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAddProject } from "@/lib/mutations/projects";
import ImageSubmissionArea from "../image-submission-area";
import AppDropzone from "../app-dropzone";
import { ImagePlus, Video } from "lucide-react";
import { useSession } from "@/providers/session-provider";
import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { getErrorMessage } from "@/lib/error-messages";

export default function NewProjectDialog({
  files = [],
  setFiles,
  children,
}: {
  files?: File[];
  setFiles?: (files: File[]) => void;
  children: React.ReactNode;
}) {
  const { toast } = useToast();
  const router = useRouter();

  const [open, setOpen] = useState<boolean>(false);
  const [name, setName] = useState<string>("");
  const [projectFiles, setProjectFiles] = useState<File[]>([]);
  const [projectType, setProjectType] = useState<"image" | "video">("image");
  const isVideoProject = projectType === "video";
  const selectedFile = projectFiles[0];

  const session = useSession();
  const addProject = useAddProject(session.user._id, session.token);

  function handleCreate() {
    addProject.mutate(
      {
        uid: session.user._id,
        token: session.token,
        name: name,
        images: isVideoProject ? [] : projectFiles,
        video: isVideoProject ? projectFiles[0] : undefined,
      },
      {
        onSuccess: (project) => {
          setOpen(false);
          toast({
              title: "Project created successfully",
              description: isVideoProject ? "The video was added to the new project." : "The images were added to the new project.",
          });
          if (project) router.push(`/dashboard/${project._id}`);
        },
        onError: (error) => {
          const { title, description } = getErrorMessage("project-create", error);
          toast({
            title,
            description,
            variant: "destructive",
          });
        },
      },
    );
  }

  useEffect(() => {
    if (files.length > 0) {
      setProjectFiles(files);
      setProjectType(files[0].type.startsWith("video/") ? "video" : "image");
      setOpen(true);
    }
  }, [files]);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setName("");
      setProjectFiles([]);
      setProjectType("image");
      if (setFiles) setFiles([]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
        </DialogHeader>
        <Label htmlFor="project-name">Project Name</Label>
        <Input
          id="project-name"
          placeholder="Enter project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex gap-2">
          <Button
            type="button"
            variant={projectType === "image" ? "default" : "outline"}
            onClick={() => {
              setProjectType("image");
              setProjectFiles([]);
            }}
          >
            <ImagePlus className="mr-2 size-4" />
            Image project
          </Button>
          <Button
            type="button"
            variant={projectType === "video" ? "default" : "outline"}
            onClick={() => {
              setProjectType("video");
              setProjectFiles([]);
            }}
          >
            <Video className="mr-2 size-4" />
            Video project
          </Button>
        </div>
        {isVideoProject ? (
          <div className="h-64">
            <AppDropzone
              onDrop={(selected) => setProjectFiles(selected.slice(0, 1))}
              accept={{ "video/*": [".mp4", ".webm", ".mov"] }}
            >
              <div className="flex flex-col gap-4 items-center justify-center">
                <Video size={64} />
                <p className="font-medium text-lg">
                  {selectedFile ? `Video selected: ${selectedFile.name}` : "Drag and drop a video or choose a file"}
                </p>
              </div>
            </AppDropzone>
          </div>
        ) : (
          <ImageSubmissionArea
            onDrop={setProjectFiles}
            receivedFiles={projectFiles.length > 0 ? projectFiles : files}
          />
        )}
        <DialogFooter>
          <Button
            onClick={() => handleCreate()}
            disabled={projectFiles.length <= 0 || name === ""}
            className="inline-flex items-center gap-1"
          >
            <span>Create</span>
            {addProject.isPending && (
              <LoaderCircle className="size-[1em] animate-spin" />
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
