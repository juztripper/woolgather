import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { attachmentRequest } from "../library/attachments";

export function ProjectSourceThumbnail({
  attachmentId,
}: {
  attachmentId: string;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true,
      objectUrl: string | undefined,
      requested = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || requested) return;
      requested = true;
      observer.disconnect();
      void attachmentRequest(attachmentId)
        .then((response) => response.blob())
        .then((blob) => {
          if (!active) return;
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        })
        .catch(() => {});
    });
    if (element.current) observer.observe(element.current);
    return () => {
      active = false;
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);
  return (
    <span ref={element} className="project-source-icon" aria-hidden="true">
      {url ? (
        <img className="project-source-preview" src={url} alt="" />
      ) : (
        <ImageIcon className="size-full" />
      )}
    </span>
  );
}
