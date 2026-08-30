import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  PROJECTION_THREAD_CONTENT_SEARCH_LIMITS,
  ProjectionSnapshotQuery,
} from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const metadataLayer = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: (workspaceRoot) =>
      Effect.succeed({
        canonicalKey: `test:${workspaceRoot}`,
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://example.test/search.git",
        },
        rootPath: workspaceRoot,
      }),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    resolvePath: () => Effect.succeed(null),
  }),
);

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const testLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
  Layer.provideMerge(ProjectEnrichment.layer),
  Layer.provideMerge(metadataLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "thread-content-search-test-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("searches bounded durable thread content without changing the legacy search RPC", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    const projectId = ProjectId.make("project:search-current");
    const otherProjectId = ProjectId.make("project:search-other");
    const activeThreadId = ThreadId.make("thread:search-active");
    const archivedThreadId = ThreadId.make("thread:search-archived");
    const deletedThreadId = ThreadId.make("thread:search-deleted");
    const otherThreadId = ThreadId.make("thread:search-other");
    const longText = `${"prefix ".repeat(2_000)}literal %_! needle😀終 ${"suffix ".repeat(2_000)}`;

    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES
        (${projectId}, 'Current', '/tmp/search-current', NULL, '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-10T00:00:00.000Z', NULL),
        (${otherProjectId}, 'Other', '/tmp/search-other', NULL, '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-10T00:00:00.000Z', NULL)
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
        settled_override, settled_at, deleted_at
      ) VALUES
        (${activeThreadId}, ${projectId}, 'Needle active title', '{}', 'full-access', 'default',
          'main', '/tmp/search-current', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-10T00:00:00.000Z', NULL, NULL, NULL, NULL),
        (${archivedThreadId}, ${projectId}, 'Archived history', '{}', 'full-access', 'default',
          'main', '/tmp/search-current', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-09T00:00:00.000Z', '2026-01-09T00:00:00.000Z', NULL, NULL, NULL),
        (${deletedThreadId}, ${projectId}, 'Deleted needle', '{}', 'full-access', 'default',
          'main', '/tmp/search-current', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-08T00:00:00.000Z', NULL, NULL, NULL, '2026-01-08T00:00:00.000Z'),
        (${otherThreadId}, ${otherProjectId}, 'Other needle', '{}', 'full-access', 'default',
          'main', '/tmp/search-other', NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-07T00:00:00.000Z', NULL, NULL, NULL, NULL)
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, attachments_json, is_streaming,
        created_at, updated_at
      ) VALUES
        ('message:legacy-active', ${activeThreadId}, NULL, 'user', 'legacy needle', '[]', 0,
          '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
        ('message:legacy-archived', ${archivedThreadId}, NULL, 'user', 'archived needle', '[]', 0,
          '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
        ('message:legacy-other', ${otherThreadId}, NULL, 'user', 'secret needle', '[]', 0,
          '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_thread_id, status,
        requested_at, completed_at, payload_json
      ) VALUES
        ('run:visible', ${activeThreadId}, 1, 'codex', NULL, 'completed',
          '2026-01-06T00:00:00.000Z', '2026-01-06T00:01:00.000Z', '{}'),
        ('run:rolled-back', ${activeThreadId}, 2, 'codex', NULL, 'rolled_back',
          '2026-01-07T00:00:00.000Z', '2026-01-07T00:01:00.000Z', '{}'),
        ('run:cancelled', ${activeThreadId}, 3, 'codex', NULL, 'cancelled',
          '2026-01-08T00:00:00.000Z', '2026-01-08T00:01:00.000Z', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
      ) VALUES
        ('message:v2-visible', ${activeThreadId}, 'run:visible', NULL, 'assistant', 0,
          '2026-01-06T00:00:00.000Z', '2026-01-06T00:00:00.000Z',
          ${encodeUnknownJsonString({ text: longText })}),
        ('message:v2-rolled-back', ${activeThreadId}, 'run:rolled-back', NULL, 'assistant', 0,
          '2026-01-07T00:00:00.000Z', '2026-01-07T00:00:00.000Z',
          ${encodeUnknownJsonString({ text: "rolled-back needle" })}),
        ('message:v2-cancelled', ${activeThreadId}, 'run:cancelled', NULL, 'user', 0,
          '2026-01-08T00:00:00.000Z', '2026-01-08T00:00:00.000Z',
          ${encodeUnknownJsonString({ text: "cancelled needle" })})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json
      ) VALUES
        ('item:v2-visible', ${activeThreadId}, 'run:visible', NULL, NULL, NULL, NULL, 1,
          'assistant_message', 'completed', '2026-01-06T00:00:00.000Z',
          ${encodeUnknownJsonString({ messageId: "message:v2-visible", text: longText, streaming: false })}),
        ('item:v2-rolled-back', ${activeThreadId}, 'run:rolled-back', NULL, NULL, NULL, NULL, 2,
          'assistant_message', 'completed', '2026-01-07T00:00:00.000Z',
          ${encodeUnknownJsonString({ messageId: "message:v2-rolled-back", text: "rolled-back needle", streaming: false })}),
        ('item:v2-cancelled', ${activeThreadId}, 'run:cancelled', NULL, NULL, NULL, NULL, 3,
          'user_message', 'completed', '2026-01-08T00:00:00.000Z',
          ${encodeUnknownJsonString({ messageId: "message:v2-cancelled", text: "cancelled needle", inputIntent: "queued_turn" })})
    `;

    const firstPage = yield* query.searchThreadContent({
      projectId,
      query: "needle",
      includeArchived: true,
      offset: 0,
      limit: 2,
      snippetChars: 80,
    });
    assert.lengthOf(firstPage.hits, 2);
    assert.isTrue(firstPage.hasMore);
    assert.equal(firstPage.nextOffset, 2);
    assert.deepEqual(
      firstPage.hits.map((hit) => [hit.source, hit.origin]),
      [
        ["title", "legacy"],
        ["assistant", "v2"],
      ],
    );
    const anchored = firstPage.hits[1];
    assert.equal(anchored?.sourceThreadId, activeThreadId);
    assert.equal(anchored?.messageId, "message:v2-visible");
    assert.equal(anchored?.itemId, "item:v2-visible");
    assert.match(anchored?.snippet ?? "", /needle/);
    assert.isAtMost(Array.from(anchored?.snippet ?? "").length, 80);
    assert.isTrue(anchored?.snippetTruncated ?? false);

    const secondPage = yield* query.searchThreadContent({
      projectId,
      query: "needle",
      includeArchived: true,
      offset: firstPage.nextOffset ?? 0,
      limit: 10,
      snippetChars: 80,
    });
    assert.deepEqual(
      secondPage.hits.map((hit) => hit.threadId),
      [archivedThreadId, activeThreadId],
    );
    assert.isNull(secondPage.hits[0]?.sourceThreadId ?? null);
    assert.isTrue(secondPage.hits[0]?.archived ?? false);
    assert.notInclude(
      secondPage.hits.map((hit) => hit.threadId),
      otherThreadId,
    );
    assert.notInclude(
      secondPage.hits.map((hit) => hit.threadId),
      deletedThreadId,
    );

    const activeOnly = yield* query.searchThreadContent({
      projectId,
      query: "needle",
      includeArchived: false,
      offset: 0,
      limit: 10,
      snippetChars: 80,
    });
    assert.isTrue(activeOnly.hits.every((hit) => !hit.archived));

    const literal = yield* query.searchThreadContent({
      projectId,
      threadId: activeThreadId,
      query: "%_!",
      includeArchived: false,
      offset: 0,
      limit: 10,
      snippetChars: 64,
    });
    assert.deepEqual(
      literal.hits.map((hit) => hit.messageId),
      [MessageId.make("message:v2-visible")],
    );

    const nonAscii = yield* query.searchThreadContent({
      projectId,
      threadId: activeThreadId,
      query: "needle😀終",
      includeArchived: false,
      offset: 0,
      limit: 10,
      snippetChars: 64,
    });
    assert.match(nonAscii.hits[0]?.snippet ?? "", /needle😀終/);
    assert.isAtMost(Array.from(nonAscii.hits[0]?.snippet ?? "").length, 64);

    const legacyResult = yield* query.searchThreads({ query: "needle", limit: 50 });
    assert.deepEqual(Object.keys(legacyResult), ["matches"]);
    assert.isTrue(legacyResult.matches.every((match) => match.source !== undefined));
    assert.isTrue(legacyResult.matches.every((match) => !("itemId" in match)));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects out-of-bounds lower-layer requests before querying", () =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    const failure = yield* Effect.flip(
      query.searchThreadContent({
        projectId: ProjectId.make("project:unused"),
        query: "needle",
        includeArchived: false,
        offset: PROJECTION_THREAD_CONTENT_SEARCH_LIMITS.offsetMax + 1,
        limit: 1,
        snippetChars: 64,
      }),
    );
    assert.equal(failure._tag, "ProjectionThreadContentSearchInputError");
  }).pipe(Effect.provide(testLayer)),
);
