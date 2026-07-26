import { createMusicBrainzClient } from "../server/musicbrainz.mjs";

const [title = "Everything in Its Right Place", artist = "Radiohead", album = "Kid A"] = process.argv.slice(2);
const client = createMusicBrainzClient();
const candidates = await client.search({ album, artist, limit: 3, title });
console.log(JSON.stringify({ candidates }, null, 2));
if (candidates[0]) {
  console.log(JSON.stringify({ details: await client.details(candidates[0].recordingId, candidates[0].releaseId) }, null, 2));
}
