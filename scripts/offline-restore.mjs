import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { createBackupService } from "../server/backup/index.mjs";

const usage = () => {
  console.error("Usage: node scripts/offline-restore.mjs <backup-root> <backup-id> <empty-destination-data-root>");
  process.exitCode = 2;
};

const [backupRootArg, backupId, destinationRootArg, ...extra] = process.argv.slice(2);
if (!backupRootArg || !backupId || !destinationRootArg || extra.length > 0) {
  usage();
} else {
  const backupRoot = path.resolve(backupRootArg);
  const destinationDataRoot = path.resolve(destinationRootArg);
  const snapshotPath = path.join(backupRoot, backupId, "database", "nebula.sqlite");
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const service = createBackupService({
      backupRoot,
      dataRoot: destinationDataRoot,
      database: snapshot,
      databasePath: snapshotPath
    });
    const inspected = await service.inspect({ backupId });
    const restored = await service.restore({
      backupId,
      destinationDataRoot,
      destinationDatabasePath: path.join(destinationDataRoot, "nebula.sqlite")
    });
    console.log(JSON.stringify({
      backupId: restored.backupId,
      format: inspected.manifest.format,
      formatVersion: inspected.manifest.formatVersion,
      metadataCacheFiles: restored.metadataCacheFiles,
      restored: true
    }));
  } finally {
    snapshot.close();
  }
}
