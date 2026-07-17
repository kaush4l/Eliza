// Unthrottled timer backend: background tabs clamp window timers to as
// little as one tick per minute, which starves the VM's I/O polling.
// Dedicated-worker timers are exempt, so the page routes setTimeout /
// setInterval here (see the patch at the top of index.html's main script).
const timers = new Map();
onmessage = (e) => {
    const d = e.data;
    if (d.clear !== undefined) {
        const h = timers.get(d.clear);
        if (h !== undefined) { clearTimeout(h); clearInterval(h); timers.delete(d.clear); }
        return;
    }
    if (d.repeat) {
        timers.set(d.id, setInterval(() => postMessage(d.id), Math.max(d.ms || 0, 4)));
    } else {
        timers.set(d.id, setTimeout(() => { postMessage(d.id); timers.delete(d.id); }, d.ms || 0));
    }
};
