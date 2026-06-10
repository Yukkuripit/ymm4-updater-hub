// functions/api/upload.js
export async function onRequest(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // OPTIONS プリフライト
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (context.request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  // 簡易パスワード認証
  const authHeader = context.request.headers.get('Authorization');
  const password = authHeader?.split(' ')[1];
  const validPassword = context.env.ADMIN_PASSWORD;
  if (!validPassword || password !== validPassword) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders });
  }

  // FormData 解析
  const formData = await context.request.formData();
  const developerName = formData.get('developerName') || 'unknown';
  const pluginName = formData.get('pluginName');
  const version = formData.get('version');
  const description = formData.get('description') || '';
  const force = formData.get('force') === 'true';
  const ymmFile = formData.get('ymmeFile');

  if (!pluginName || !version || !ymmFile) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // GitHub設定 (環境変数から取得)
  const githubToken = context.env.GITHUB_TOKEN;
  const repoOwner = context.env.GITHUB_REPO_OWNER;
  const repoName = context.env.GITHUB_REPO_NAME;
  const branch = 'main';

  if (!githubToken || !repoOwner || !repoName) {
    return new Response(JSON.stringify({ error: 'GitHub settings missing' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // ヘルパー: 文字列を Base64 に変換 (Buffer 不使用)
  function toBase64(str) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function fromBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const decoder = new TextDecoder();
    return decoder.decode(bytes);
  }

  // ファイルを ArrayBuffer → Base64
  async function fileToBase64(file) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // GitHub API 呼び出し (User-Agent必須)
  async function callGitHubAPI(url, method, body = null) {
    const headers = {
      'Authorization': `token ${githubToken}`,
      'User-Agent': 'YMM4-AutoUpdater-Cloudflare',
      'Accept': 'application/vnd.github.v3+json'
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(url, options);
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`GitHub API error ${res.status}: ${errorText}`);
    }
    return res.json();
  }

  // ファイルのSHAを取得 (存在しない場合は null)
  async function getFileSha(path) {
    const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${path}`;
    try {
      const data = await callGitHubAPI(url, 'GET');
      return data.sha;
    } catch (err) {
      if (err.message.includes('404')) return null;
      throw err;
    }
  }

  // ファイルをコミット (作成または更新)
  async function commitFile(path, contentBase64, commitMessage) {
    const sha = await getFileSha(path);
    const body = {
      message: commitMessage,
      content: contentBase64,
      branch: branch
    };
    if (sha) body.sha = sha;
    const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${path}`;
    return await callGitHubAPI(url, 'PUT', body);
  }

  try {
    // 1. ymmeファイルをアップロード
    const fileBase64 = await fileToBase64(ymmFile);
    const filePath = `plugins/${developerName}/${pluginName}_v${version}.ymme`;
    const rawYmmUrl = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${branch}/${filePath}`;
    await commitFile(filePath, fileBase64, `Upload ${developerName}/${pluginName} v${version}`);

    // 2. update.xml を更新
    const xmlPath = `updates/${developerName}/${pluginName}.xml`;
    let xmlContent = '';
    try {
      const sha = await getFileSha(xmlPath);
      if (sha) {
        const data = await callGitHubAPI(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${xmlPath}`, 'GET');
        xmlContent = fromBase64(data.content);
      } else {
        xmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n<item>\n</item>';
      }
    } catch (err) {
      xmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n<item>\n</item>';
    }

    // 簡易XMLテキスト置換
    const targetTag = `<target name="${pluginName}">`;
    const endTag = `</target>`;
    const newTarget = `<target name="${pluginName}">
    <version>${version}</version>
    <description>${description}</description>
    <force>${force}</force>
    <file>${rawYmmUrl}</file>
</target>`;

    if (xmlContent.includes(targetTag)) {
      const startIdx = xmlContent.indexOf(targetTag);
      const endIdx = xmlContent.indexOf(endTag, startIdx) + endTag.length;
      xmlContent = xmlContent.substring(0, startIdx) + newTarget + xmlContent.substring(endIdx);
    } else {
      xmlContent = xmlContent.replace('</item>', `  ${newTarget}\n</item>`);
    }

    const xmlBase64 = toBase64(xmlContent);
    await commitFile(xmlPath, xmlBase64, `Update ${pluginName} to v${version}`);

    const publicXmlUrl = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${branch}/${xmlPath}`;

    return new Response(JSON.stringify({ success: true, message: 'Plugin updated', xmlUrl: publicXmlUrl }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
