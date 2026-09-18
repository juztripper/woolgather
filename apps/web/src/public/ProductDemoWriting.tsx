import type { IdeaBlock } from "../../../../packages/domain/src/ideaBlocks";
import IdeaBlockEditor, {
  IdeaAttachmentTransport,
} from "../library/IdeaBlockEditor";

// The tour has only authored text. Even an unexpected file reference cannot
// escape into the authenticated attachment client.
const blockedAttachments = {
  async upload(): Promise<Response> {
    throw new Error("Attachments are unavailable in this read-only example.");
  },
  async read(): Promise<Blob> {
    throw new Error("Attachments are unavailable in this read-only example.");
  },
};

export default function ProductDemoWriting({
  blocks,
}: {
  blocks: IdeaBlock[];
}) {
  return (
    <IdeaAttachmentTransport.Provider value={blockedAttachments}>
      <IdeaBlockEditor blocks={blocks} readOnly />
    </IdeaAttachmentTransport.Provider>
  );
}
