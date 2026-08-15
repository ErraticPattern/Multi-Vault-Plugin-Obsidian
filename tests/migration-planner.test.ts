import { describe, expect, it } from 'vitest';
import { collectMigrationSnapshot } from '../src/migration/obsidian-snapshot';
import { makeMigrationReviewModel } from '../src/migration/migration-view-models';
import {
  planMoveOrCopy,
  planStandaloneRelink,
  type LinkSnapshot,
  type NoteSnapshot,
} from '../src/migration/migration-planner';

function link(
  content: string,
  original: string,
  linkTarget: string,
  resolvedPath: string | null,
  kind: LinkSnapshot['kind'] = 'wikilink',
): LinkSnapshot {
  const startOffset = content.indexOf(original);
  if (startOffset === -1) throw new Error(`Missing fixture link: ${original}`);
  return {
    sourcePath: '',
    original,
    linkTarget,
    startOffset,
    endOffset: startOffset + original.length,
    resolvedPath,
    kind,
  };
}

function note(path: string, content: string, links: LinkSnapshot[]): NoteSnapshot {
  return {
    path,
    basename: path.split('/').pop()!.replace(/\.md$/i, ''),
    content,
    links: links.map((item) => ({ ...item, sourcePath: path })),
  };
}

describe('planMoveOrCopy move', () => {
  it('plans both sides of a move and reports links it cannot safely rewrite', () => {
    const sourceContent = [
      'Useful [[EEG#Acquisition|EEG setup]].',
      'Existing [[ideas::Existing]].',
      'Embed ![[Diagram.png]].',
      'Missing [[Unknown]].',
      'Self [[Zerotier]].',
      'Markdown [EEG](Notes/EEG.md).',
    ].join('\n');
    const backlinkContent = 'See [[Zerotier|ZeroTier]].';
    const unsupportedBacklinks = 'Embed ![[Zerotier]] and [ZeroTier](../Projects/Zerotier.md).';

    const notes = [
      note('Projects/Zerotier.md', sourceContent, [
        link(sourceContent, '[[EEG#Acquisition|EEG setup]]', 'EEG#Acquisition', 'Notes/EEG.md'),
        link(sourceContent, '[[ideas::Existing]]', 'ideas::Existing', null),
        link(sourceContent, '![[Diagram.png]]', 'Diagram.png', 'Attachments/Diagram.png', 'embed'),
        link(sourceContent, '[[Unknown]]', 'Unknown', null),
        link(sourceContent, '[[Zerotier]]', 'Zerotier', 'Projects/Zerotier.md'),
        link(sourceContent, '[EEG](Notes/EEG.md)', 'Notes/EEG.md', 'Notes/EEG.md', 'markdown'),
      ]),
      note('Notes/EEG.md', 'EEG content.', []),
      note('Notes/Network index.md', backlinkContent, [
        link(backlinkContent, '[[Zerotier|ZeroTier]]', 'Zerotier', 'Projects/Zerotier.md'),
      ]),
      note('Notes/Unsupported.md', unsupportedBacklinks, [
        link(unsupportedBacklinks, '![[Zerotier]]', 'Zerotier', 'Projects/Zerotier.md', 'embed'),
        link(unsupportedBacklinks, '[ZeroTier](../Projects/Zerotier.md)', '../Projects/Zerotier.md', 'Projects/Zerotier.md', 'markdown'),
      ]),
    ];

    const plan = planMoveOrCopy({
      mode: 'move',
      sourcePath: 'Projects/Zerotier.md',
      sourceVaultName: 'ideas',
      targetVaultName: 'mathematics',
      destinationAbsolutePath: 'C:/vaults/mathematics/Notes/Zerotier.md',
      destinationRelativePath: 'Notes/Zerotier.md',
      notes,
      sourceIndexedFiles: notes.map(({ path, basename }) => ({ relativePath: path, basename })),
      targetIndexedFiles: [],
      preserveLinks: true,
    });

    expect(plan.destinationContent).toContain('[[EEG@ideas#Acquisition|EEG setup]]');
    expect(plan.destinationContent).toContain('[[ideas::Existing]]');
    expect(plan.destinationContent).toContain('![[Diagram.png]]');
    expect(plan.destinationContent).toContain('[[Unknown]]');
    expect(plan.destinationContent).toContain('[[Zerotier]]');
    expect(plan.destinationContent).toContain('[EEG](Notes/EEG.md)');
    expect(plan.backlinkEdits).toEqual([{
      path: 'Notes/Network index.md',
      originalContent: backlinkContent,
      updatedContent: 'See [[Zerotier@mathematics|ZeroTier]].',
      rewrittenLinks: 1,
      rewrites: [{
        before: '[[Zerotier|ZeroTier]]',
        after: '[[Zerotier@mathematics|ZeroTier]]',
      }],
    }]);
    expect(plan.outgoingLinksRewritten).toBe(1);
    expect(plan.backlinksRewritten).toBe(1);
    expect(plan.skipped.map((item) => item.reason).sort()).toEqual([
      'already-cross-vault',
      'embed',
      'embed',
      'markdown-link',
      'markdown-link',
      'self-link',
      'unresolved',
    ]);
  });

  it('uses the destination relative path when its basename is ambiguous', () => {
    const backlinkContent = '[[Zerotier]]';
    const notes = [
      note('Projects/Zerotier.md', 'Body', []),
      note('Index.md', backlinkContent, [
        link(backlinkContent, '[[Zerotier]]', 'Zerotier', 'Projects/Zerotier.md'),
      ]),
    ];

    const plan = planMoveOrCopy({
      mode: 'move',
      sourcePath: 'Projects/Zerotier.md',
      sourceVaultName: 'ideas',
      targetVaultName: 'mathematics',
      destinationAbsolutePath: 'C:/vaults/mathematics/Notes/Zerotier.md',
      destinationRelativePath: 'Notes/Zerotier.md',
      notes,
      sourceIndexedFiles: notes.map(({ path, basename }) => ({ relativePath: path, basename })),
      targetIndexedFiles: [{ relativePath: 'Archive/Zerotier.md', basename: 'Zerotier' }],
      preserveLinks: true,
    });

    expect(plan.backlinkEdits[0].updatedContent).toBe('[[Notes/Zerotier@mathematics]]');
  });
});

describe('makeMigrationReviewModel', () => {
  it('reports reviewed overwrite warnings from the plan metadata', () => {
    expect(makeMigrationReviewModel({
      mode: 'copy',
      sourcePath: 'Source.md',
      sourceOriginalContent: 'source',
      destinationAbsolutePath: 'C:/math/Notes/Source.md',
      destinationRelativePath: 'Notes/Source.md',
      destinationContent: 'source',
      destinationPolicy: 'overwrite-reviewed',
      destinationOriginalContent: 'existing',
      backlinkEdits: [],
      outgoingLinksRewritten: 0,
      backlinksRewritten: 0,
      skipped: [],
    } as never)).toMatchObject({
      overwritesDestination: true,
      destinationOriginalBytes: 8,
    });
  });
});

describe('collectMigrationSnapshot', () => {
  it('collects exact wikilink, Markdown-link, and embed references with resolutions', async () => {
    const content = 'Wiki [[EEG]] markdown [EEG](EEG.md) embed ![[plot.png]].';
    const wikiStart = content.indexOf('[[EEG]]');
    const markdownStart = content.indexOf('[EEG](EEG.md)');
    const embedStart = content.indexOf('![[plot.png]]');
    const file = { path: 'Notes/Source.md', basename: 'Source', extension: 'md' };
    const target = { path: 'Notes/EEG.md', basename: 'EEG', extension: 'md' };
    const image = { path: 'Attachments/plot.png', basename: 'plot', extension: 'png' };
    const cache = {
      links: [
        {
          original: '[[EEG]]',
          link: 'EEG',
          position: { start: { offset: wikiStart }, end: { offset: wikiStart + 7 } },
        },
        {
          original: '[EEG](EEG.md)',
          link: 'EEG.md',
          position: { start: { offset: markdownStart }, end: { offset: markdownStart + 13 } },
        },
      ],
      embeds: [{
        original: '![[plot.png]]',
        link: 'plot.png',
        position: { start: { offset: embedStart }, end: { offset: embedStart + 13 } },
      }],
    };
    const app = {
      vault: {
        getFileByPath: (filePath: string) => filePath === file.path ? file : null,
        read: async () => content,
      },
      metadataCache: {
        resolvedLinks: {},
        getFileCache: () => cache,
        getFirstLinkpathDest: (targetPath: string) => targetPath === 'plot.png' ? image : target,
      },
    };

    const snapshot = await collectMigrationSnapshot(app as never, file.path);

    expect(snapshot).toEqual([note('Notes/Source.md', content, [
      link(content, '[[EEG]]', 'EEG', 'Notes/EEG.md'),
      link(content, '[EEG](EEG.md)', 'EEG.md', 'Notes/EEG.md', 'markdown'),
      link(content, '![[plot.png]]', 'plot.png', 'Attachments/plot.png', 'embed'),
    ])]);
  });
});

describe('copy and standalone relink planning', () => {
  it('copies transformed outgoing links without changing source backlinks', () => {
    const sourceContent = 'Uses [[EEG]].';
    const backlinkContent = 'Points to [[Zerotier]].';
    const notes = [
      note('Projects/Zerotier.md', sourceContent, [
        link(sourceContent, '[[EEG]]', 'EEG', 'Notes/EEG.md'),
      ]),
      note('Notes/EEG.md', 'EEG', []),
      note('Index.md', backlinkContent, [
        link(backlinkContent, '[[Zerotier]]', 'Zerotier', 'Projects/Zerotier.md'),
      ]),
    ];

    const plan = planMoveOrCopy({
      mode: 'copy',
      sourcePath: 'Projects/Zerotier.md',
      sourceVaultName: 'ideas',
      targetVaultName: 'mathematics',
      destinationAbsolutePath: 'C:/vaults/mathematics/Notes/Zerotier.md',
      destinationRelativePath: 'Notes/Zerotier.md',
      notes,
      sourceIndexedFiles: notes.map(({ path, basename }) => ({ relativePath: path, basename })),
      targetIndexedFiles: [],
      preserveLinks: true,
    });

    expect(plan.destinationContent).toBe('Uses [[EEG@ideas]].');
    expect(plan.backlinkEdits).toEqual([]);
    expect(plan.backlinksRewritten).toBe(0);
    expect(plan.sourceOriginalContent).toBe(sourceContent);
  });

  it('relinks backlinks to an existing target without editing either duplicate', () => {
    const sourceContent = 'Source duplicate body.';
    const backlinkContent = 'See [[Zerotier#Setup|setup]].';
    const notes = [
      note('Projects/Zerotier.md', sourceContent, []),
      note('Index.md', backlinkContent, [
        link(
          backlinkContent,
          '[[Zerotier#Setup|setup]]',
          'Zerotier#Setup',
          'Projects/Zerotier.md',
        ),
      ]),
    ];

    const plan = planStandaloneRelink({
      sourcePath: 'Projects/Zerotier.md',
      targetVaultName: 'mathematics',
      targetRelativePath: 'Notes/Zerotier.md',
      notes,
      targetIndexedFiles: [{ relativePath: 'Notes/Zerotier.md', basename: 'Zerotier' }],
    });

    expect(plan.mode).toBe('relink');
    expect(plan.destinationContent).toBeNull();
    expect(plan.destinationAbsolutePath).toBeNull();
    expect(plan.backlinkEdits[0].updatedContent)
      .toBe('See [[Zerotier@mathematics#Setup|setup]].');
    expect(plan.backlinksRewritten).toBe(1);
    expect(plan.sourceOriginalContent).toBe(sourceContent);
  });
});

describe('cross-vault link format', () => {
  function planWith(overrides: Partial<Parameters<typeof planMoveOrCopy>[0]>) {
    const sourceContent = [
      'Uses [[EEG]].',
      'Already [[Existing@ideas]].',
      'Legacy [[ideas::Legacy]].',
    ].join('\n');
    const notes = [
      note('Projects/Zerotier.md', sourceContent, [
        link(sourceContent, '[[EEG]]', 'EEG', 'Notes/EEG.md'),
        link(sourceContent, '[[Existing@ideas]]', 'Existing@ideas', null),
        link(sourceContent, '[[ideas::Legacy]]', 'ideas::Legacy', null),
      ]),
      note('Notes/EEG.md', 'EEG content.', []),
    ];

    return planMoveOrCopy({
      mode: 'move',
      sourcePath: 'Projects/Zerotier.md',
      sourceVaultName: 'ideas',
      targetVaultName: 'mathematics',
      destinationAbsolutePath: 'C:/vaults/mathematics/Notes/Zerotier.md',
      destinationRelativePath: 'Notes/Zerotier.md',
      notes,
      sourceIndexedFiles: notes.map(({ path, basename }) => ({ relativePath: path, basename })),
      targetIndexedFiles: [],
      preserveLinks: true,
      ...overrides,
    });
  }

  it('writes the note@vault form by default', () => {
    expect(planWith({}).destinationContent).toContain('[[EEG@ideas]]');
  });

  it('writes the legacy form when the vault asks for it', () => {
    expect(planWith({ linkFormat: 'vault-double-colon' }).destinationContent).toContain('[[ideas::EEG]]');
  });

  it('never rewrites a link that already points at another vault, in either form', () => {
    const plan = planWith({ knownVaultNames: ['ideas', 'mathematics', 'medicine'] });

    expect(plan.destinationContent).toContain('[[Existing@ideas]]');
    expect(plan.destinationContent).toContain('[[ideas::Legacy]]');
    expect(plan.skipped.filter((entry) => entry.reason === 'already-cross-vault')).toHaveLength(2);
  });
});
