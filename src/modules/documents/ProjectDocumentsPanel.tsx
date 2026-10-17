/** Project document library embedded in the project workspace (Documents tab). Owned by the documents module. */
import { DocLibrary } from './shared'

export default function ProjectDocumentsPanel({ projectId }: { projectId: string }) {
  return <DocLibrary projectId={projectId} />
}
