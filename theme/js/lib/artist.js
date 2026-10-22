"use strict";
// Artist files (#25): who an artist is, from open sources, cached in the profile.
//   MusicBrainz   the artist (by the file's MUSICBRAINZ_ARTISTID tag, else by name), type, area, dates, genres,
//                 members and the Wikidata link
//   Wikidata      the Wikipedia article in each language, and a free picture on Wikimedia Commons
//   Wikipedia     the biography, in the interface language when there is one (else English, else any)
//   ListenBrainz  related artists (listened to by the same people)
//   artist.txt / artist.jpg (or .png) beside the album's files replace the biography / the picture
// No keys or sign-ins. MusicBrainz asks for one request a second and a named client: requests go out one by one.
// Needs lib/translate.js (trHttp) and lib/waveform.js (fnv).

const ART_DIR = fb.ProfilePath + "audio-archive-cache\\artists\\";
const ART_DAYS = 30, ART_MISS_DAYS = 7;   // a file is looked up again after 30 days; a failed lookup after 7
const ART_UA = { "User-Agent": "RhinE-AudioArchive/1.10 ( https://github.com/ericzhang12111-cell/RhinE )", Accept: "application/json" };
// the interface language's Wikipedia first (Chinese in simplified characters), then English, then the artist's own
const ART_WIKI = { "zh-CN": "zh", ja: "ja", ko: "ko", fr: "fr", de: "de", en: "en" };
const ART_LANGS = [...new Set([ART_WIKI[UI_LANG] || "en", "en", "ja", "ko", "zh", "fr", "de"])];
const ART = { mem: new Map(), queue: [], busy: false, last: 0, listeners: [], pics: new Map() };
const TF_MBID = fb.TitleFormat("[%musicbrainz_artistid%]|[%musicbrainz artist id%]");

const artKey = name => fnv(String(name).trim().toLowerCase());
const artFile = name => ART_DIR + artKey(name) + ".json";
function artSave(rec) {
    if (!utils.IsDirectory(ART_DIR)) utils.CreateFolder(ART_DIR);
    utils.WriteTextFile(artFile(rec.name), JSON.stringify(rec), false);
}
function artChanged(rec) { ART.mem.set(artKey(rec.name), rec); for (const f of ART.listeners) f(rec); }

// the artist's file, or a waiting one ({ state: "loading" }) while it is looked up; `handle` (any of the artist's
// tracks) gives the MusicBrainz id tag and the folder for artist.txt / artist.jpg
function artistGet(name, handle) {
    name = String(name || "").trim();
    if (!name || /^(various artists|unknown artist|va)$/i.test(name)) return null;
    const k = artKey(name);
    let rec = ART.mem.get(k);
    if (!rec && utils.IsFile(artFile(name))) {
        try { rec = JSON.parse(utils.ReadTextFile(artFile(name), 65001)); } catch (e) { rec = null; }
        if (rec) ART.mem.set(k, rec);
    }
    const age = rec ? Date.now() - (rec.t || 0) : Infinity;
    const stale = !rec || (rec.state === "none" ? age > ART_MISS_DAYS * 864e5 : age > ART_DAYS * 864e5);
    if (stale && !(rec && rec.state === "loading")) {
        const keep = rec && rec.state === "ok" ? rec : null;   // an old file stays on show while it is refreshed
        rec = keep || { name, state: "loading", log: [] };
        ART.mem.set(k, rec);
        artLookup(name, handle, keep);
    }
    if (handle) artLocal(rec, handle);
    return rec;
}

// artist.txt / artist.jpg beside the files win over what was fetched (read each time: they may be edited)
function artLocal(rec, handle) {
    const dir = handle.Path.replace(/[^\\]*$/, "");
    if (rec.localDir === dir) return;
    rec.localDir = dir;
    rec.localText = utils.IsFile(dir + "artist.txt") ? utils.ReadTextFile(dir + "artist.txt", 65001).trim() : "";
    rec.localPic = ["artist.jpg", "artist.png", "artist.jpeg"].map(f => dir + f).find(f => utils.IsFile(f)) || "";
}

// one request at a time, MusicBrainz at most once a second
function artHttp(url, done, mb = false) {
    ART.queue.push({ url, done, mb });
    artPump();
}
function artPump() {
    if (ART.busy || !ART.queue.length) return;
    const job = ART.queue[0], wait = job.mb ? Math.max(0, ART.last + 1100 - Date.now()) : 0;
    ART.busy = true;
    window.SetTimeout(() => {
        if (job.mb) ART.last = Date.now();
        trHttp("GET", job.url, "", ART_UA, (st, txt) => {
            ART.queue.shift(); ART.busy = false;
            let d = null;
            if (st === 200) try { d = JSON.parse(txt); } catch (e) { d = null; }
            try { job.done(d, st); } finally { artPump(); }
        });
    }, wait);
}

function artLookup(name, handle, keep) {
    const rec = { name, state: "loading", log: [], t: Date.now() };
    const show = keep || rec;
    const log = (what, how) => { show.log = (show.log || []).filter(l => l[0] !== what).concat([[what, how]]); artChanged(show); };
    const finish = state => {
        rec.state = state; rec.t = Date.now(); rec.log = show.log;
        if (state === "none" && keep) { keep.t = Date.now(); artSave(keep); artChanged(keep); return; }   // offline: keep the old file
        artSave(rec); artChanged(rec);
    };
    const tag = handle ? (TF_MBID.EvalWithMetadb(handle).split("|").find(v => v) || "").split(/[;/,\s]+/)[0] : "";
    const byId = mbid => artHttp(`https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels+genres+artist-rels+aliases&fmt=json`, (d, st) => {
        if (!d) { log("MUSICBRAINZ", st ? "NOT FOUND" : "OFFLINE"); finish("none"); return; }
        artFromMb(rec, d);
        log("MUSICBRAINZ", tag ? "MATCHED · TAG" : "MATCHED · NAME");
        artRelated(rec, log, () => artWiki(rec, log, () => finish("ok")));
    }, true);
    if (/^[0-9a-f-]{36}$/i.test(tag)) { byId(tag); return; }
    log("MUSICBRAINZ", "SEARCHING");
    artHttp(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${name.replace(/"/g, "")}"`)}&limit=5&fmt=json`, (d, st) => {
        if (!d) { log("MUSICBRAINZ", st ? "ERROR " + st : "OFFLINE"); finish("none"); return; }
        // only a sure match: the same name (or one of its aliases), and a high score
        const norm = s => String(s || "").toLowerCase().replace(/[\s.·・]/g, "");
        const hit = (d.artists || []).find(a => a.score >= 90 && (norm(a.name) === norm(name) || (a.aliases || []).some(x => norm(x.name) === norm(name))));
        if (!hit) { log("MUSICBRAINZ", "NO MATCH"); finish("none"); return; }
        byId(hit.id);
    }, true);
}

function artFromMb(rec, d) {
    const rels = d.relations || [];
    Object.assign(rec, {
        mbid: d.id, name: rec.name, mbName: d.name, type: d.type || "", country: d.country || "",
        area: (d["begin-area"] || d.area || {}).name || "", begin: (d["life-span"] || {}).begin || "", end: (d["life-span"] || {}).end || "",
        disambiguation: d.disambiguation || "",
        genres: (d.genres || []).sort((a, b) => b.count - a.count).slice(0, 4).map(g => g.name),
        members: rels.filter(r => r.type === "member of band" && r.direction === "backward" && !r.ended).map(r => ({ name: r.artist.name, role: (r.attributes || [])[0] || "" })).slice(0, 6),
        wikidata: ((rels.find(r => r.type === "wikidata") || {}).url || {}).resource || "",
    });
}

function artRelated(rec, log, next) {
    artHttp(`https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids=${rec.mbid}&algorithm=session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30`, d => {
        const list = Array.isArray(d) ? d : [];
        const top = list.length ? list[0].score || 1 : 1;
        rec.related = list.slice(0, 8).map(a => ({ name: a.name, mbid: a.artist_mbid, score: Math.round(100 * (a.score || 0) / top) / 100 }));
        log("LISTENBRAINZ", rec.related.length ? `${pad(rec.related.length, 2)} RELATED` : "NONE");
        next();
    });
}

function artWiki(rec, log, next) {
    const q = (/Q\d+$/.exec(rec.wikidata) || [])[0];
    if (!q) { log("WIKIPEDIA", "NO ARTICLE"); next(); return; }
    const sites = ART_LANGS.map(l => l + "wiki").join("|");
    artHttp(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${q}&props=sitelinks|claims&sitefilter=${sites}&format=json`, d => {
        const e = d && d.entities && d.entities[q];
        if (!e) { log("WIKIDATA", "OFFLINE"); next(); return; }
        rec.wikiTitles = {};
        for (const l of ART_LANGS) if (e.sitelinks && e.sitelinks[l + "wiki"]) rec.wikiTitles[l] = e.sitelinks[l + "wiki"].title;
        const img = ((((e.claims || {}).P18 || [])[0] || {}).mainsnak || {}).datavalue;
        const pic = img ? img.value : "";
        // the biography in the first language that has an article (more are fetched when the language changes)
        const lang = ART_LANGS.find(l => rec.wikiTitles[l]);
        const then = () => pic ? artPicture(rec, pic, log, next) : next();
        if (!lang) { log("WIKIPEDIA", "NO ARTICLE"); then(); return; }
        artWikiText(rec, lang, ok => { log("WIKIPEDIA", ok ? `${lang.toUpperCase()} · ${(rec.wiki[lang].text.length / 1024).toFixed(1)} KB` : "OFFLINE"); then(); });
    });
}

// a language's article lead (all its paragraphs, up to 2400 characters) into rec.wiki[lang]; Chinese in simplified
// characters
function artWikiText(rec, lang, done) {
    const title = rec.wikiTitles && rec.wikiTitles[lang];
    if (!title) { done(false); return; }
    artHttp(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exsectionformat=plain&exchars=2400&redirects=1&format=json&titles=${encodeURIComponent(title)}${lang === "zh" ? "&variant=zh-hans" : ""}`, d => {
        const p = d && d.query && d.query.pages && Object.values(d.query.pages)[0];
        const text = p && p.extract ? p.extract.replace(/\n{2,}/g, "\n").trim() : "";
        if (!text) { done(false); return; }
        rec.wiki = rec.wiki || {};
        rec.wiki[lang] = { title: p.title, text, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}` };
        done(true);
    });
}

// the Commons picture, 640 px wide, with its author and licence (shown under it)
function artPicture(rec, file, log, next) {
    artHttp(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent("File:" + file)}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=640&format=json`, d => {
        const p = d && d.query && d.query.pages, ii = p && (Object.values(p)[0].imageinfo || [])[0];
        if (!ii || !ii.thumburl) { log("PICTURE", "NONE"); next(); return; }
        const m = ii.extmetadata || {}, strip = s => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        const out = ART_DIR + artKey(rec.name) + (/\.png$/i.test(ii.thumburl) ? ".png" : ".jpg");
        rec.pic = { file: out, page: ii.descriptionurl || "", credit: strip((m.Artist || {}).value).slice(0, 60), licence: strip((m.LicenseShortName || {}).value) };
        if (!utils.IsDirectory(ART_DIR)) utils.CreateFolder(ART_DIR);
        ART.pics.delete(out);
        utils.DownloadFileAsync(ii.thumburl, out);   // arrives through artistDownloaded()
        log("PICTURE", "COMMONS");
        next();
    });
}

// foobar2000's on_download_file_done, forwarded by the panel; true when it was one of ours
function artistDownloaded(path, ok) {
    if (!path || path.indexOf(ART_DIR) !== 0) return false;
    ART.pics.delete(path);
    for (const rec of ART.mem.values()) if (rec.pic && rec.pic.file === path) { if (!ok) rec.pic = null; artChanged(rec); }
    return true;
}

// the biography to show: artist.txt, else the interface language's article (fetched on first use), else any
function artistBio(rec) {
    if (!rec) return null;
    if (rec.localText) return { text: rec.localText, source: "ARTIST.TXT", lang: "", url: "" };
    const w = rec.wiki || {}, want = ART_LANGS[0];
    if (!w[want] && rec.wikiTitles && rec.wikiTitles[want] && !rec.wikiAsked) {
        rec.wikiAsked = true;
        artWikiText(rec, want, ok => { if (ok) { artSave(rec); artChanged(rec); } });
    }
    const lang = ART_LANGS.find(l => w[l]);
    return lang ? { text: w[lang].text, source: "WIKIPEDIA", lang, url: w[lang].url, licence: "CC BY-SA 4.0" } : null;
}

// the picture as a Direct2D image (artist.jpg first), or null
function artistPicture(rec) {
    const f = rec && (rec.localPic || (rec.pic && rec.pic.file));
    if (!f || !utils.IsFile(f)) return null;
    if (!ART.pics.has(f)) { let img = null; try { img = d2d.Image(f); } catch (e) { img = null; } ART.pics.set(f, img); }
    return ART.pics.get(f);
}

// a short number for the file (ARTIST NO. 0412), stable for the name
const artistNo = name => parseInt(artKey(name).slice(0, 6), 16) % 10000;
