// Files arriving on the composer by paste or drag & drop. Enter/leave are counted so moving over
// child elements does not flicker the drop overlay; a drop while disabled is swallowed.

import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

export function useFileDrop({ disabled, onFiles }: { disabled: boolean; onFiles(files: ArrayLike<File>): void }) {
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (disabled) return;
    let files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) {
      files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === "file")
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null);
    }
    if (files.length === 0) return;
    e.preventDefault();
    onFiles(files);
  };

  const onDragEnter = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = disabled ? "none" : "copy";
  };
  const onDragLeave = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled) return;
    onFiles(e.dataTransfer.files);
  };

  return { dragging, onPaste, dropZoneProps: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
