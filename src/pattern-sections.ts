import * as v from 'valibot';
import { JsonObjectSchema } from './contracts';
import type { BlockSummary, JsonObject } from './contracts';
import type { WordPress } from './wordpress';
import { containsPath, liveRow, sharedReference, requireCondition as assert } from './inspection';
import { debugDetails } from './debug';
import { budgetedMs } from './native';
import { pause } from './timing';

export interface PatternSectionState extends JsonObject {
  section_client_id: string | null;
  state_available: boolean;
}

export function patternSectionState(wp: WordPress): PatternSectionState {
  const store = wp.data.select('core/block-editor');

  if (!store.__unstableGetTemporarilyEditingAsBlocks) {
    return { section_client_id: null, state_available: false };
  }

  try {
    return {
      section_client_id: store.__unstableGetTemporarilyEditingAsBlocks() ?? null,
      state_available: true,
    };
  } catch (error) {
    return { section_client_id: null, state_available: false, debug: debugDetails(error) };
  }
}

export async function openPatternSection(
  wp: WordPress,
  rows: BlockSummary[],
  sectionClientId: string,
  available: () => void,
): Promise<void> {
  const section = liveRow(rows, sectionClientId, 'open_pattern_section.section_client_id');
  const metadata = section.attributes.metadata;
  const ancestors = rows.filter(
    (row) => row.path.length < section.path.length && containsPath(row.path, section.path),
  );
  assert(
    section.support === 'supported' &&
      !sharedReference(section.block) &&
      v.is(JsonObjectSchema, metadata) &&
      typeof metadata.patternName === 'string' &&
      Boolean(metadata.patternName) &&
      !ancestors.some(
        (row) =>
          v.is(JsonObjectSchema, row.attributes.metadata) &&
          Boolean(row.attributes.metadata.patternName),
      ),
    'pattern_section_required',
    { section_client_id: sectionClientId, constraint: 'outermost_unsynced_pattern_section' },
  );

  const store = wp.data.select('core/block-editor');
  const actions = wp.data.dispatch('core/block-editor');
  assert(actions.__unstableSetTemporarilyEditingAsBlocks, 'pattern_section_open_unavailable', {
    capability: '__unstableSetTemporarilyEditingAsBlocks',
    section_client_id: sectionClientId,
  });
  assert(store.__unstableGetTemporarilyEditingAsBlocks, 'pattern_section_open_unavailable', {
    capability: '__unstableGetTemporarilyEditingAsBlocks',
    section_client_id: sectionClientId,
  });

  for (const row of [...ancestors, section]) {
    assert(store.canEditBlock(row.clientId), 'block_locked', { block_name: row.name });
  }

  available();
  await actions.__unstableSetTemporarilyEditingAsBlocks(sectionClientId);
  const deadline = Date.now() + budgetedMs(1000);
  let state = patternSectionState(wp);

  while (state.section_client_id !== sectionClientId && Date.now() < deadline) {
    await pause(25);
    state = patternSectionState(wp);
  }

  assert(
    state.state_available && state.section_client_id === sectionClientId,
    'pattern_section_not_opened',
    {
      requested_section_client_id: sectionClientId,
      pattern_section: state,
      editing_mode: store.getBlockEditingMode(sectionClientId),
    },
  );
  available();
}
