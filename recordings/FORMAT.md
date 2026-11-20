# Gesture trace format

`ansuz.gesture-take` version **4** adds an independent multitouch delivery stream. Versions 1–3 remain readable. The file contains evidence; recognizer interpretations and their model versions do not change the original. Account ownership remains in the local/cloud envelope, not inferred from gesture content.

`frames` still describe the primary-pointer simulation at 120 ticks per second, including viewport, object response and element response. This preserves existing game behavior and comparison with older takes. It does not claim that the host, display or digitizer sampled at 120 Hz.

`initial_contacts` contains `[pointer_id, x, y]` for contacts already down at recording start. `delivered` contains rows with the following fixed columns:

| Column | Meaning |
| --- | --- |
| `tick` | Recording-relative simulation tick at which the event was delivered |
| `host_event_ms` | The original host event timestamp in milliseconds; preserve it as a 64-bit number. Its epoch is host-specific, not Unix time and not the Contract observer clock. |
| `phase_0_down_1_move_2_up_3_cancel_4_blur` | Down, move, release, cancellation, or focus loss |
| `pointer_id` | Contact identity; stable during a contact, not a person's finger identity |
| `x`, `y` | Canvas coordinates, origin at the top left; see the frame's viewport |
| `dx`, `dy` | Host-delivered displacement |
| `buttons` | Host button bits; touch contacts may use zero, so Down/Up/Cancel determine contact lifetime |

Rows retain delivery order. Timestamps from different contacts need not establish that order. Focus loss clears all contacts; it is not fabricated as a normal release. Hover moves are excluded. Hosts and the engine may coalesce movement before it reaches this stream. It is not raw digitizer data and contains no measured pressure claim. The separate `observed` track is a legacy Contract observer; native hosts may report only the primary contact there and combine cancellation with release. Use `delivered` for version-4 multitouch analysis.

Replay reconstructs all contact markers from the initial state and delivery events. Game/element recognizers still consume the original primary-pointer frame stream. An AI replay tool should likewise preserve contact identity and terminal events, adapting timestamps to its clock rather than waiting for each sample to finish rendering. A frame-paced automation transport may need to coalesce overdue moves while preserving down/up/cancel boundaries.

`capture.stop_reason` is `manual`, `duration_limit`, `input_limit`, or `interrupted`. `capture.dropped_events` makes known recording loss explicit; nonzero loss requires `input_limit`. An interruption or input limit stops recording and submits the captured portion through the normal save operation. Focus loss has a 250 ms simulation-time handoff window so pressing Stop can complete its command without its button disappearing on pointer-down. If the app is suspended, that handoff/save may complete only after resuming. A save failure remains visible and retryable; capture ending is not proof of a successful save. A process killed before it can submit a take still cannot recover the in-memory recording.

Bounds are 20 seconds / 2400 simulation frames, ten simultaneous contacts, 8000 delivered events, a 900,000-byte delivered-event budget, 4800 legacy observer events and 2 MiB per trace. Reaching an input bound stops capture rather than silently continuing with missing contacts. Open contacts at a deliberate stop or truncation are legitimate; replay clears their markers at the end without inventing recorded releases.

Local saving and replay use `ansuz/shared/gesture_trace.rs` to validate versions, numeric fields, contact lifetimes, event order by tick, bounds and capture metadata. Failed imports preserve the previously loaded take. The public archive gateway now validates the same supported trace versions, exact SHA-256 and metadata before a service-only Snapback mutation accepts the recording. Durable per-take upload states live beside the source trace and resume while the app is running. Agent credential management, cloud deletion and off-host backup remain separate hardening work.

Capture time is fixed at Record, and retrying the same local save uses a persisted content/metadata key to avoid creating a duplicate. Cloud archival remains explicit Sync with the existing owner/digest deduplication and download checksum verification.
