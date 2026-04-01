const API_BASE = '/api/entities';

function parseRow(row) {
  if (!row) return row;
  const parsed = { ...row };
  if (typeof parsed.history === 'string') {
    try { parsed.history = JSON.parse(parsed.history); } catch { parsed.history = []; }
  }
  if (typeof parsed.diversion_data === 'string') {
    try { parsed.diversion_data = JSON.parse(parsed.diversion_data); } catch { parsed.diversion_data = null; }
  }
  if (parsed.total_volume_mt !== undefined) parsed.total_volume_mt = parseFloat(parsed.total_volume_mt) || 0;
  if (parsed.batch_size !== undefined && parsed.batch_size !== null) parsed.batch_size = parseFloat(parsed.batch_size);
  if (parsed.production_hours !== undefined && parsed.production_hours !== null) parsed.production_hours = parseFloat(parsed.production_hours);
  if (parsed.run_rate !== undefined && parsed.run_rate !== null) parsed.run_rate = parseFloat(parsed.run_rate);
  if (parsed.ha_available !== undefined && parsed.ha_available !== null) parsed.ha_available = parseInt(parsed.ha_available);
  if (parsed.changeover_time !== undefined && parsed.changeover_time !== null) parsed.changeover_time = parseFloat(parsed.changeover_time);
  if (parsed.priority_seq !== undefined && parsed.priority_seq !== null) parsed.priority_seq = parseFloat(parsed.priority_seq);
  return parsed;
}

function createEntity(entityName) {
  return {
    async list(sort = '-created_date', limit = 10000) {
      const res = await fetch(`${API_BASE}/${entityName}?sort=${sort}&limit=${limit}`);
      if (!res.ok) throw new Error(await res.text());
      const rows = await res.json();
      return rows.map(parseRow);
    },
    async create(data) {
      const res = await fetch(`${API_BASE}/${entityName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      return parseRow(await res.json());
    },
    async bulkCreate(dataArray) {
      const res = await fetch(`${API_BASE}/${entityName}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dataArray),
      });
      if (!res.ok) throw new Error(await res.text());
      const rows = await res.json();
      return rows.map(parseRow);
    },
    async update(id, data) {
      const res = await fetch(`${API_BASE}/${entityName}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      return parseRow(await res.json());
    },
    async delete(id) {
      const res = await fetch(`${API_BASE}/${entityName}/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },
    async deleteAll() {
      const res = await fetch(`${API_BASE}/${entityName}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },
  };
}

export const base44 = {
  entities: {
    Order: createEntity('Order'),
    KnowledgeBase: createEntity('KnowledgeBase'),
    KnowledgeBaseUpload: createEntity('KnowledgeBaseUpload'),
    Next10DaysRecord: createEntity('Next10DaysRecord'),
    Next10DaysUpload: createEntity('Next10DaysUpload'),
  },
  auth: {
    async me() {
      return { id: 'local-user', email: 'user@nexfeed.local', role: 'admin', full_name: 'Local User' };
    },
    logout() {},
    redirectToLogin() {},
  },
  integrations: {
    Core: {
      async InvokeLLM({ prompt }) {
        try {
          const res = await fetch('/api/ai/recommendations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemPrompt: 'You are a helpful assistant.',
              userPrompt: prompt,
              maxTokens: 400,
            }),
          });
          if (!res.ok) return '';
          const data = await res.json();
          return data.content || '';
        } catch { return ''; }
      },
      async UploadFile({ file }) {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        if (!res.ok) throw new Error('Upload failed');
        return await res.json();
      },
      async ExtractDataFromUploadedFile({ file_url, json_schema }) {
        const res = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_url, json_schema }),
        });
        if (!res.ok) throw new Error('Extraction failed');
        return await res.json();
      },
    },
  },
  appLogs: {
    async logUserInApp() {},
  },
};
