export type Listing = {
  id: string;
  name: string;
  address: string;
  timezone: string;
  color: string;
  currency: string;
  bufferDays: number;
  checkoutHour: number;
  cleaningBufferHours: number;
  photoIds: string[];
  ready: boolean;
  version: number;
  hasDoorCode: boolean;
  houseManual: {
    wifi: string;
    checkin: string;
    parking: string;
    washroom: string;
    rules: string;
  };
};
/** Calendar source or destination for one property (section 8). */
export type Connection = {
  id: string;
  listingId: string;
  platform: string;
  platformName: string;
  label: string | null;
  /** False for an export-only link (INT 01). */
  importing: boolean;
  enabled: boolean;
  health:
    | "PENDING"
    | "HEALTHY"
    | "DEGRADED"
    | "FAILING"
    | "PAUSED_BY_SOURCE"
    | "EXPORT_ONLY"
    | "DISABLED";
  /** CAL 05 visible run result of the latest check. */
  lastResult:
    "NO_CHANGES" | "UPDATED" | "NEEDS_REVIEW" | "COULD_NOT_CHECK" | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  nextFetchAt: string;
  sourceRetryAfter: string | null;
  checking: boolean;
  failures: number;
  coverageEnd: string | null;
  policy: {
    mode: "UNSET" | "RESERVATIONS" | "OWNER_BLOCKS" | "BY_LABEL";
    labels: Record<string, string> | null;
    version: number;
    decidedAt: string | null;
  };
  refreshGuidance: string;
  exportTokenGeneration: number;
};
/** Stay information, separate from generic availability (section 8). */
export type Reservation = {
  id: string;
  listingId: string;
  blockId: string | null;
  source: "IMPORTED" | "DIRECT";
  platform: string;
  status: "CONFIRMED" | "CANCELLED" | "RECLASSIFIED";
  startDate: string;
  endDate: string;
  guestName: string;
  hasGuestContact: boolean;
  price: number | null;
  currency: string;
  firstObservedAt: string;
  version: number;
};
export type Lifecycle =
  | "ACTIVE"
  | "MISSING_OBSERVED"
  | "AWAITING_DECISION"
  | "RETAINED_HOLD"
  | "RELEASED";
/** A protected (or recently released) date range and why (section 12). */
export type CalendarBlock = {
  id: string;
  listingId: string;
  connectionId: string | null;
  platform: string;
  identityKind: string;
  startDate: string;
  endDate: string;
  classification: string;
  effectiveClass: string;
  evidenceRule: string;
  suggested: string | null;
  labelKey: string | null;
  overrideClassification: string | null;
  lifecycle: Lifecycle;
  decisionReason: "ABSENCE" | "CANCELLATION" | null;
  sourceStatus: string;
  holdType: string | null;
  reason: string | null;
  reviewFlags: string[];
  pendingChange: { startDate?: string; endDate?: string } | null;
  buffer: { before: number; after: number; overridden: boolean };
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  missingSince: string | null;
  releasedAt: string | null;
  restorableUntil: string | null;
  revision: number;
  reservation: Reservation | null;
};
export type Conflict = {
  id: string;
  listingId: string;
  blockAId: string;
  blockBId: string;
  kind:
    | "RESERVATION_RESERVATION"
    | "RESERVATION_HOLD"
    | "UNCERTAIN_OVERLAP"
    | "BUFFER_ONLY";
  severity: "HIGH" | "MEDIUM" | "LOW";
  state: "OPEN" | "RESOLVED";
  overlapStart: string;
  overlapEnd: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  revision: number;
};
export type Task = {
  id: string;
  listingId: string;
  reservationId: string | null;
  taskType: "TURNOVER" | "MANUAL";
  departureDate: string | null;
  reviewRequired: boolean;
  reviewReason: string | null;
  closedAt: string | null;
  closeReason: string | null;
  cleanerId: string | null;
  title: string;
  status: string;
  scheduledAt: string;
  verifyBy: string;
  acceptBy: string | null;
  photoId: string | null;
  codeReleasedAt: string | null;
  note: string;
  version: number;
};
export type Cleaner = {
  id: string;
  name: string;
  listingIds: string[];
  enabled: boolean;
};
export type Rule = {
  id: string;
  listingId: string | null;
  name: string;
  keywords: string[];
  manualField: string | null;
  template: string;
  action: string;
  enabled: boolean;
  priority: number;
  version: number;
};
export type Settings = {
  paused: boolean;
  cleaning: boolean;
  messaging: boolean;
  ai: boolean;
  confidence: number;
  version: number;
};
export type Notice = {
  id: string;
  title: string;
  body: string;
  href: string;
  readAt: string | null;
  createdAt: string;
};
export type WorkspaceData = {
  /** REL 01: SHADOW records calendar decisions without serving or alerting. */
  workspace: { id: string; name: string; calendarMode: "SHADOW" | "LIVE" };
  user: { name: string; role: string };
  listings: Listing[];
  connections: Connection[];
  tasks: Task[];
  cleaners: Cleaner[];
  settings: Settings;
  rules: Rule[];
  notifications: Notice[];
  integrations: { platform: string; enabled: boolean }[];
  providers: Record<string, boolean>;
  vapidPublicKey: string | null;
  staleMinutes: number;
};
export type Thread = {
  id: string;
  listingId: string;
  reservationId: string;
  externalId: string;
  platform: string;
  status: string;
  intent: string;
  manual: boolean;
  guestName: string;
  preview: string;
  updatedAt: string;
};
export type Message = {
  id: string;
  body: string;
  sender: string;
  status: string;
  automated: boolean;
  aiConfidence: number | null;
  explanation: string | null;
  sentAt: string | null;
  createdAt: string;
};
/** What removing a property would change (GET listings/:id/removal). */
export type RemovalPreview = {
  id: string;
  name: string;
  version: number;
  calendarsChecked: number;
  exportLinks: number;
  /** Export links a platform (or anyone) read in the last two weeks. */
  linksInUse: { name: string; lastAt: string }[];
  upcomingStays: number;
  cleaningsToCancel: number;
  cleanersToTell: number;
  cleanersToldAutomatically: boolean;
  cleaningUnderWay: boolean;
  openConversations: number;
};
/** A property removed from the app (GET listings/removed). */
export type RemovedProperty = {
  id: string;
  name: string;
  address: string;
  removedAt: string;
  /** When it is deleted permanently unless restored first. */
  erasesAt: string;
  /** Requests for its paused links since it was removed. */
  linksStillRequested: { name: string; lastAt: string }[];
};
/** What deleting a removed property would delete (GET listings/:id/erasure). */
export type ErasurePreview = {
  id: string;
  name: string;
  removedAt: string;
  erasesAt: string;
  stays: number;
  conversations: number;
  messages: number;
  cleanings: number;
  photos: number;
  calendarLinks: number;
  /** Cleaners who stay on the team, with this property taken off their list. */
  cleaners: number;
};
/** Messages oldest first; `hasOlder` says whether earlier ones remain. */
export type MessagePage = { messages: Message[]; hasOlder: boolean };
/** A conversation opens on its newest page of messages. */
export type Conversation = MessagePage & {
  thread: Thread;
  reservation: Reservation;
  pastStays: number;
};
export type Insights = {
  from: string;
  to: string;
  listings: {
    listingId: string;
    name: string;
    color: string;
    currency: string;
    occupancy: number;
    revenue: number;
    pricedStays: number;
    totalStays: number;
    nights: string[];
  }[];
  sync: { platform: string; checks: number; uptime: number | null }[];
  responseSeconds: number | null;
  responseSamples: number;
  cleaningHours: number | null;
  cleaningSamples: number;
};
export type AuditEntry = {
  id: string;
  actorId: string;
  action: string;
  entity: string;
  entityId: string | null;
  reason: string;
  createdAt: string;
};
export type Job = {
  id: string;
  kind: string;
  entityId: string;
  status: string;
  automated: boolean;
  category: string;
  attempts: number;
  error: string | null;
  createdAt: string;
};
