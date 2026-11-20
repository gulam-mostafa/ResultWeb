/**
 * Runtime guard for the শাখা registry (`sectionRegistry`).
 *
 * Renders `useStudents` once with an empty dataset and no tenant so the offline
 * fallback path runs, then asserts the exposed registry / selectors are usable
 * objects that always default to `ক`.
 */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  useStudents,
  createSectionRegistry,
  declareSection,
  relabelSection,
  dropSection,
} from '../../src/hooks/useStudents.js';

let captured = null;

function Harness() {
  captured = useStudents({
    dataset: { students: [], marks: {}, remarks: {}, notices: [], audits: [], meta: {} },
    datasetRef: { current: { students: [], marks: {} } },
    updateDataset: () => {},
    schoolId: '',
    schoolRef: null,
    activeYear: '2026',
    canWriteTenant: false,
    runCloudSave: () => Promise.resolve({ synced: false }),
  });
  return null;
}

const check = (label, condition) => {
  if (!condition) {
    console.error(`FAIL — ${label}`);
    process.exit(1);
  }
  console.log(`ok — ${label}`);
};

renderToString(createElement(Harness));

check('sectionRegistry is defined', captured !== null && typeof captured.sectionRegistry === 'object');
['pre', 'c1', 'c2', 'c3', 'c4', 'c5'].forEach((classId) => {
  check(`class ${classId} defaults to শাখা ক`, captured.sectionRegistry[classId]?.['ক'] === true);
});
check('getSectionsOfClass(pre) starts with ক', captured.getSectionsOfClass('pre')[0] === 'ক');
check('getSectionsOfClass(pre) only lists ক initially', captured.getSectionsOfClass('pre').length === 1);
check('addSection returns the new label', captured.addSection('c1', 'খ') === 'খ');
check('addSection falls back to ক for a blank label', captured.addSection('c1', '   ') === 'ক');
check('renameSection rejects a no-op', captured.renameSection('c1', 'খ', 'খ') === false);
check('removeSection protects ক', captured.removeSection('c1', 'ক') === false);
check('getStudentsOfSection is total', Array.isArray(captured.getStudentsOfSection('c1', 'ক')));

// Pure registry helpers — the same functions the callbacks delegate to.
check('declareSection adds খ next to ক', declareSection(undefined, 'c2', 'খ').c2['খ'] === true
  && declareSection(undefined, 'c2', 'খ').c2['ক'] === true);
check('declareSection is immutable', !('খ' in createSectionRegistry().c2));
check('declareSection ignores a blank class', declareSection(undefined, '', 'খ').c2?.['খ'] !== true);
check('relabelSection moves খ ➔ গ', (() => {
  const after = relabelSection(declareSection(undefined, 'c2', 'খ'), 'c2', 'খ', 'গ');
  return after.c2['গ'] === true && after.c2['খ'] === undefined;
})());
check('relabelSection keeps ক', relabelSection(declareSection(undefined, 'c2', 'খ'), 'c2', 'খ', 'গ').c2['ক'] === true);
check('dropSection removes an empty শাখা', dropSection(declareSection(undefined, 'c2', 'খ'), 'c2', 'খ').c2['খ'] === undefined);
check('dropSection never removes ক', dropSection(declareSection(undefined, 'c2', 'খ'), 'c2', 'ক').c2['ক'] === true);

console.log('PASS — section registry defaults / add / rename / remove guards');
