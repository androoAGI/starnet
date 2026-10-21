'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const notice = document.getElementById('lab-notice');
  if (!notice || document.getElementById('colony-console-link')) return;
  const link = document.createElement('a'); link.id = 'colony-console-link';
  link.href = '/colony/index.html'; link.textContent = 'Business-Steuerung';
  link.style.cssText = 'margin-left:12px;color:inherit;text-decoration:underline';
  notice.insertAdjacentElement('afterend', link);
  let syncing = false;
  let framedRadial = false;
  let workflowStatusKey = null;
  const refreshWorkflowStatus = () => {
    const key = JSON.stringify([window.ColonyRoomState?.mappings, window.ColonyProcessState?.processes]);
    if (key === workflowStatusKey) return;
    workflowStatusKey = key;
    if (typeof WorkflowsWindow !== 'undefined') WorkflowsWindow.refresh();
    if (typeof WorkflowPanel !== 'undefined' && WorkflowPanel.isOpen()) WorkflowPanel.refresh();
  };
  const headers = () => ({ 'X-StarNet-Token': window.__STARNET_API_TOKEN__ });
  // Trust a body only after the status says it succeeded — a failed Colony read must never be
  // adopted as state (see connectors.js readJSON).
  const readJSON = async (route) => {
    const response = await fetch(route, { headers: headers(), cache: 'no-store' });
    if (!response.ok) throw new Error('COLONY_READ_FAILED ' + response.status + ' ' + route);
    return response.json();
  };
  const sync = async () => {
    if (syncing || document.hidden || typeof App === 'undefined' || !App.station || !App.station()) return;
    syncing = true;
    try {
      const response = await fetch('/api/colony/installation', { headers: headers(), cache: 'no-store' });
      if (!response.ok) throw new Error('COLONY_INSTALLATION_READ_FAILED');
      const installation = await response.json();
      window.ColonyRoomState = installation;
      if (!installation.installed) { window.ColonyProcessState = null; refreshWorkflowStatus(); return; }
      const value = App.colonyInstallation()?.commitId === installation.commitId ? null : await readJSON('/api/save');
      const adopted = value ? await App.adoptColonyInstallation(value.save, installation) : true;
      // Frame the star once on opening it; never reset a user's pan/zoom on polling.
      if (adopted && !framedRadial && App.station().serialize().meta.colonyLayout === 'radial-v1'
          && typeof World !== 'undefined' && World.frameReviewRoom) {
        framedRadial = World.frameReviewRoom(null) === true;
      }
      let banner = document.getElementById('colony-sync-notice');
      if (!adopted && !banner) {
        banner = document.createElement('p'); banner.id = 'colony-sync-notice';
        banner.textContent = 'Neue BU-Einrichtung liegt bereit. Lokale Änderungen oder aktive Arbeit verhindern gerade den sicheren Abgleich; nichts wird überschrieben.';
        banner.style.cssText = 'position:fixed;bottom:70px;left:16px;right:16px;z-index:9999;padding:16px;background:#514333;color:#fff1dc;border-radius:12px;font:16px sans-serif';
        document.body.append(banner);
      } else if (adopted && banner) banner.remove();
      const snapshot = await readJSON('/api/colony');
      window.ColonyProcessState = snapshot;
      if (typeof World !== 'undefined' && World.setColonyTeam) World.setColonyTeam(snapshot);
      if (typeof StationUI !== 'undefined' && StationUI.setColonyTeam) StationUI.setColonyTeam(snapshot);
      refreshWorkflowStatus();
    } catch (_) {
      window.ColonyProcessState = null;
      refreshWorkflowStatus();
      if (typeof World !== 'undefined' && World.setColonyTeam) World.setColonyTeam(null);
      if (typeof StationUI !== 'undefined' && StationUI.setColonyTeam) StationUI.setColonyTeam(null);
    }
    finally { syncing = false; }
  };
  setInterval(sync, 10000);
  sync();
});
