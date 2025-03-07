import * as core from '@actions/core';
import * as glob from '@actions/glob';
import { Storage, TransferManager } from '@google-cloud/storage';
import * as path from 'path';
import { withFile as withTemporaryFile } from 'tmp-promise';

import { CacheActionMetadata } from './gcs-utils';
import { getState } from './state';
import { createTar } from './tar-utils';

async function main() {
  const state = getState();

  if (state.cacheHitKind === 'exact') {
    console.log(
      '🌀 Skipping uploading cache as the cache was hit by exact match.',
    );
    return;
  }

  console.log('Bucket:', state.bucket);
  console.log('Key file name:', state.keyFileName);
  console.log('Target file name:', state.targetFileName);
  console.log('Path:', state.path);
  const bucket = new Storage({ keyFilename: state.keyFileName }).bucket(
    state.bucket,
  );
  const targetFileName = state.targetFileName;
  const [targetFileExists] = await bucket
    .file(targetFileName)
    .exists()
    .catch((err) => {
      core.error('Failed to check if the file already exists');
      throw err;
    });

  core.debug(`Target file name: ${targetFileName}.`);

  if (targetFileExists) {
    console.log(
      '🌀 Skipping uploading cache as it already exists (probably due to another job).',
    );
    return;
  }

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const globber = await glob.create(state.path, {
    implicitDescendants: false,
  });

  const paths = await globber
    .glob()
    .then((files) => files.map((file) => path.relative(workspace, file)));

  core.debug(`Paths: ${JSON.stringify(paths)}.`);

  return withTemporaryFile(async (tmpFile) => {
    const compressionMethod = await core
      .group('🗜️ Creating cache archive', () =>
        createTar(tmpFile.path, paths, workspace),
      )
      .catch((err) => {
        core.error('Failed to create the archive');
        throw err;
      });

    const customMetadata: CacheActionMetadata = {
      'Cache-Action-Compression-Method': compressionMethod,
    };

    const chunkSize = 32 * 1024 * 1024;
    const tm = new TransferManager(bucket);

    core.debug(`Metadata: ${JSON.stringify(customMetadata)}.`);

    await core
      .group('🌐 Uploading cache archive to bucket', async () => {
        console.log(`🔹 Uploading file '${targetFileName}'...`);

        // Upload file in chunks using TransferManager
        await tm.uploadFileInChunks(tmpFile.path, {
          chunkSizeBytes: chunkSize,
          validation: 'md5',
          uploadName: targetFileName,
        });

        // Cast the metadata to the correct type
        const metadata: { [key: string]: string } = {
          'Cache-Action-Compression-Method': compressionMethod,
        };

        await bucket.file(targetFileName).setMetadata({
          metadata: metadata,
        });
      })
      .catch((err) => {
        core.error('Failed to upload the file');
        throw err;
      });

    console.log('✅ Successfully saved cache.');
  });
}

void main().catch((err: Error) => {
  core.error(err);
  core.setFailed(err);
});
