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
  const pluginName = formData.get('pluginName');
  const version = formData.get('version');
  const description = formData.get('description') || '';
  const force = formData.get('force') === 'true';
  const ymmFile = formData.get('ymmeFile');

  if (!pluginName || !version || !ymmFile) {
    return new Response(JSON.stringify({ error: 'Missing fields' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // GitHub設定
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

  // ヘルパー: GitHub にファイルをコミット
  async function commitFile(path, contentBase64, commitMessage) {
    // 既存ファイルのSHA取得
    let sha = null;
    const getRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${path}`, {
      headers: { Authorization: `Bearer ${githubToken}` }
    });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }
    const putRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${githubToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage,
        content: contentBase64,
        sha: sha,
        branch: branch
      })
    });
    if (!putRes.ok) throw new Error(`GitHub API error: ${await putRes.text()}`);
    return await putRes.json();
  }

  try {
    // 1. ymmeファイルをアップロード
    const fileBuffer = await ymmFile.arrayBuffer();
    const fileBase64 = Buffer.from(fileBuffer).toString('base64');
    const ymmPath = `plugins/${pluginName}_v${version}.ymme`;
    const rawYmmUrl = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${branch}/${ymmPath}`;
    await commitFile(ymmPath, fileBase64, `Upload ${pluginName} v${version}`);

    // 2. update.xml を更新
    const xmlPath = 'update.xml';
    let xmlContent = '';
    const getXmlRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/contents/${xmlPath}`, {
      headers: { Authorization: `Bearer ${githubToken}` }
    });
    if (getXmlRes.ok) {
      const data = await getXmlRes.json();
      xmlContent = Buffer.from(data.content, 'base64').toString('utf-8');
    } else {
      xmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n<item>\n</item>';
    }

    // XML パース（簡易テキスト置換）
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

    const xmlBase64 = Buffer.from(xmlContent, 'utf-8').toString('base64');
    await commitFile(xmlPath, xmlBase64, `Update ${pluginName} to v${version}`);

    return new Response(JSON.stringify({ success: true, message: 'Plugin updated' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
