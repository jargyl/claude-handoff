import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { parseSyncthingFolders } from '../src/server/system.js';

describe('parseSyncthingFolders', () => {
  it('reads labels and paths, expanding ~ and entities', () => {
    const xml = `<configuration version="37">
    <folder id="default" label="Default Folder" path="~/Sync" type="sendreceive" rescanIntervalS="3600">
        <device id="ABC"></device>
    </folder>
    <folder id="abcd-1234" label="" path="D:\\Work &amp; Play" type="sendreceive"></folder>
    <device id="ABC" name="desktop"></device>
</configuration>`;
    expect(parseSyncthingFolders(xml, '/home/me')).toEqual([
      { label: 'Default Folder', path: path.join('/home/me', '/Sync') },
      { label: 'abcd-1234', path: 'D:\\Work & Play' },
    ]);
  });
});
