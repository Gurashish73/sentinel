import { IncidentReasoningFeed } from "@/components/incident-reasoning-feed";

export default function CommanderReasoningSlot() {
  // Purely relies on the parent layout's IncidentStreamProvider for data.
  // No server-side fetching required here.
  return <IncidentReasoningFeed />;
}