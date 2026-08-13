(async function () {
  const ID = '__vdl__';

  // Toggle: fecha se já estiver aberto
  const existing = document.getElementById(ID);
  if (existing) { existing.remove(); return; }

  // Insere placeholder imediatamente (garante o toggle caso rodado 2x)
  const el = document.createElement('div');
  el.id = ID;
  el.style.cssText = [
    'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
    'width:330px', 'background:#0f172a', 'color:#e2e8f0', 'border-radius:16px',
    'border:1px solid #1e293b', 'box-shadow:0 24px 64px rgba(0,0,0,.7)',
    'font-family:system-ui,-apple-system,sans-serif', 'font-size:13px', 'overflow:hidden',
  ].join(';');
  const _phEl = document.createElement('div');
  _phEl.style.cssText = 'padding:16px;color:#64748b;font-size:13px';
  _phEl.textContent = '⏳ Buscando vídeo…';
  el.appendChild(_phEl);
  document.body.appendChild(el);

  /* ─── Helpers ─── */

  function decodeUrl(s) {
    return s.replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/\\\//g, '/').replace(/\\"/g, '"');
  }

  function inHTML(re) {
    const m = document.documentElement.innerHTML.match(re);
    return m ? decodeUrl(m[0]) : null;
  }

  function inScripts(re) {
    for (const s of document.querySelectorAll('script')) {
      const m = s.textContent.match(re);
      if (m) return decodeUrl(m[1] || m[0]);
    }
    return null;
  }

  function inWindow(globals, fields) {
    for (const g of globals) {
      try {
        const str = JSON.stringify(window[g] || {});
        for (const f of fields) {
          const m = str.match(new RegExp('"' + f + '":"(https:[^"]+)"'));
          if (m) return { url: decodeUrl(m[1]), source: g + '.' + f };
        }
      } catch (_) {}
    }
    return null;
  }

  // Busca recursiva por chave em objeto JSON (para estruturas profundas/desconhecidas)
  function deepFind(obj, key, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 14) return null;
    if (key in obj && typeof obj[key] === 'string' && obj[key].startsWith('http')) return obj[key];
    for (const v of Object.values(obj)) {
      const found = deepFind(v, key, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /* ─── Muxer MP4/CMAF mínimo (pure JS, sem libs externas) ─── */
  // Parseia boxes ISO Base Media File Format (MP4) de um ArrayBuffer
  function mp4Boxes(buf) {
    const view = new DataView(buf);
    const out = [];
    let pos = 0;
    while (pos + 8 <= buf.byteLength) {
      const size = view.getUint32(pos, false);
      if (size < 8) break;
      const type = String.fromCharCode(view.getUint8(pos+4), view.getUint8(pos+5), view.getUint8(pos+6), view.getUint8(pos+7));
      out.push({ type, buf: buf.slice(pos, pos + size) });
      pos += size;
    }
    return out;
  }

  // Concatena array de ArrayBuffers
  function mp4Cat(bufs) {
    const total = bufs.reduce((s, b) => s + b.byteLength, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const b of bufs) { out.set(new Uint8Array(b), pos); pos += b.byteLength; }
    return out.buffer;
  }

  // Copia um ArrayBuffer e escreve um uint32 big-endian numa posição
  function mp4SetU32(buf, offset, val) {
    const out = buf.slice(0);
    new DataView(out).setUint32(offset, val, false);
    return out;
  }

  // Constrói um box: 4B size + 4B type + content
  function mp4Box(type, contentBuf) {
    const size = 8 + contentBuf.byteLength;
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size, false);
    [0,1,2,3].forEach(i => { out[4+i] = type.charCodeAt(i); });
    out.set(new Uint8Array(contentBuf), 8);
    return out.buffer;
  }

  // Reconstrói um box container substituindo um filho pelo tipo
  function mp4ReplaceChild(parentBuf, childType, newChildBuf) {
    const type = String.fromCharCode(...new Uint8Array(parentBuf, 4, 4));
    const children = mp4Boxes(parentBuf.slice(8));
    return mp4Box(type, mp4Cat(children.map(c => c.type === childType ? newChildBuf : c.buf)));
  }

  // Muda track_ID no tfhd dentro de um moof (1→2, para o áudio)
  function mp4FixMoofTrack(moofBuf) {
    const traf = mp4Boxes(moofBuf.slice(8)).find(b => b.type === 'traf');
    if (!traf) return moofBuf;
    const tfhd = mp4Boxes(traf.buf.slice(8)).find(b => b.type === 'tfhd');
    if (!tfhd) return moofBuf;
    // tfhd: size(4) type(4) version+flags(4) track_ID(4) → offset 12
    const newTfhd = mp4SetU32(tfhd.buf, 12, 2);
    const newTraf = mp4ReplaceChild(traf.buf, 'tfhd', newTfhd);
    return mp4ReplaceChild(moofBuf, 'traf', newTraf);
  }

  // Cria um box trex para um track_ID
  function mp4Trex(trackId) {
    const buf = new ArrayBuffer(32);
    const v = new DataView(buf);
    v.setUint32(0, 32, false);
    [0x74,0x72,0x65,0x78].forEach((b,i) => v.setUint8(4+i, b)); // "trex"
    v.setUint32(12, trackId, false);  // track_ID
    v.setUint32(16, 1, false);        // default_sample_description_index
    return buf;
  }

  // Merge os dois moov boxes (vídeo trackId=1, áudio trackId=2)
  function mp4MergeMoov(vMoovBuf, aMoovBuf) {
    const vCh = mp4Boxes(vMoovBuf.slice(8));
    const aCh = mp4Boxes(aMoovBuf.slice(8));

    const vMvhd = vCh.find(b => b.type === 'mvhd');
    const vTrak = vCh.find(b => b.type === 'trak');
    const aTrak = aCh.find(b => b.type === 'trak');
    if (!vMvhd || !vTrak || !aTrak) throw new Error('moov incompleto');

    // mvhd: next_track_ID → 3
    const mvhdVer = new DataView(vMvhd.buf).getUint8(8);
    const newMvhd = mp4SetU32(vMvhd.buf, mvhdVer === 1 ? 116 : 104, 3);

    // tkhd do áudio: track_ID → 2
    const aTkhd = mp4Boxes(aTrak.buf.slice(8)).find(b => b.type === 'tkhd');
    if (!aTkhd) throw new Error('tkhd não encontrado');
    const tkhdVer = new DataView(aTkhd.buf).getUint8(8);
    const newTkhd = mp4SetU32(aTkhd.buf, tkhdVer === 1 ? 28 : 20, 2);
    const newATrak = mp4ReplaceChild(aTrak.buf, 'tkhd', newTkhd);

    // mvex com trex para ambos os tracks
    const newMvex = mp4Box('mvex', mp4Cat([mp4Trex(1), mp4Trex(2)]));

    // Outros filhos do moov (iods, udta, etc.) passam direto
    const extras = vCh.filter(b => !['mvhd','trak','mvex'].includes(b.type)).map(b => b.buf);

    return mp4Box('moov', mp4Cat([newMvhd, vTrak.buf, newATrak, newMvex, ...extras]));
  }

  // Busca vídeo e áudio em paralelo e monta um único MP4
  async function mergeRedditMP4(videoUrl, audioUrl, onProgress) {
    onProgress('Baixando vídeo e áudio…');
    const [vBuf, aBuf] = await Promise.all([
      fetch(videoUrl).then(r => { if (!r.ok) throw new Error('vídeo HTTP ' + r.status); return r.arrayBuffer(); }),
      fetch(audioUrl).then(r => { if (!r.ok) throw new Error('áudio HTTP ' + r.status); return r.arrayBuffer(); }),
    ]);

    onProgress('Combinando streams…');
    const vBoxes = mp4Boxes(vBuf), aBoxes = mp4Boxes(aBuf);

    const vMoov = vBoxes.find(b => b.type === 'moov');
    const aMoov = aBoxes.find(b => b.type === 'moov');
    if (!vMoov || !aMoov) throw new Error('box moov não encontrado');

    const mergedMoov = mp4MergeMoov(vMoov.buf, aMoov.buf);

    // Coleta pares moof+mdat de cada stream
    const vSegs = [], aSegs = [];
    for (let i = 0; i < vBoxes.length - 1; i++)
      if (vBoxes[i].type === 'moof' && vBoxes[i+1].type === 'mdat')
        { vSegs.push(vBoxes[i].buf, vBoxes[i+1].buf); i++; }
    for (let i = 0; i < aBoxes.length - 1; i++)
      if (aBoxes[i].type === 'moof' && aBoxes[i+1].type === 'mdat')
        { aSegs.push(mp4FixMoofTrack(aBoxes[i].buf), aBoxes[i+1].buf); i++; }

    // Intercala segmentos
    const segs = [];
    const n = Math.max(vSegs.length / 2, aSegs.length / 2);
    for (let i = 0; i < n; i++) {
      if (vSegs[i*2]) segs.push(vSegs[i*2], vSegs[i*2+1]);
      if (aSegs[i*2]) segs.push(aSegs[i*2], aSegs[i*2+1]);
    }

    onProgress('Empacotando arquivo…');
    const ftyp = vBoxes.find(b => b.type === 'ftyp');
    return mp4Cat([ftyp?.buf ?? new ArrayBuffer(0), mergedMoov, ...segs]);
  }

  function fromVideoTag() {
    for (const v of document.querySelectorAll('video')) {
      if (v.src && !v.src.startsWith('blob:')) return v.src;
      const s = v.querySelector('source');
      if (s?.src && !s.src.startsWith('blob:')) return s.src;
    }
    return null;
  }

  // Converte shortcode do Instagram em media_id (base62 com BigInt — números grandes demais para Number)
  function shortcodeToId(code) {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = 0n;
    for (const c of code) id = id * 64n + BigInt(CHARS.indexOf(c));
    return id.toString();
  }

  /* ─── Extractors por plataforma ─── */

  const extractors = {

    // Instagram: a URL do vídeo nunca está no HTML — vem de uma API autenticada.
    // O fetch abaixo roda com os cookies da sessão do browser (credentials: 'include'),
    // então funciona enquanto o usuário estiver logado.
    'instagram.com': async function () {
      const shortcode = location.pathname.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/)?.[1];
      if (!shortcode) return { url: null, hint: 'Abra o reel/post individualmente (não o feed).' };

      const mediaId = shortcodeToId(shortcode);

      try {
        const resp = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
          credentials: 'include',
          headers: { 'X-IG-App-ID': '936619743392459' },
        });

        if (resp.status === 401) return { url: null, hint: 'Você precisa estar logado no Instagram.' };
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        const data = await resp.json();
        const versions = data?.items?.[0]?.video_versions;

        if (versions?.length) {
          // Ordena por resolução e pega a melhor
          const best = versions.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
          return { url: best.url, info: `API Instagram ${best.width}×${best.height}` };
        }

        // Post é imagem, não vídeo
        return { url: null, hint: 'Este post não contém vídeo.' };
      } catch (e) {
        // Fallback: Performance API (captura CDN URL se o vídeo já foi reproduzido)
        try {
          const entries = performance.getEntriesByType('resource');
          const candidates = entries.filter(e =>
            (e.name.includes('.mp4') || e.name.includes('.m4v')) &&
            (e.name.includes('cdninstagram') || e.name.includes('fbcdn'))
          );
          if (candidates.length) {
            return { url: candidates[candidates.length - 1].name, info: 'Performance API (fallback)' };
          }
        } catch (_) {}

        return { url: null, hint: `Erro ao chamar a API: ${e.message}. Tente recarregar a página.` };
      }
    },

    'tiktok.com': async function () {
      // 1. Script tag JSON — TikTok embute os dados em <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"
      //    type="application/json">. JSON.parse decodifica /→/ automaticamente.
      //    Busca recursiva porque a estrutura muda entre feed e página individual.
      for (const tagId of ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE']) {
        try {
          const el = document.getElementById(tagId);
          if (!el) continue;
          const data = JSON.parse(el.textContent);
          // Prefere downloadAddr (geralmente sem watermark); fallback para playAddr
          const url = deepFind(data, 'downloadAddr') || deepFind(data, 'playAddr');
          if (url) return { url, info: tagId + ' (sem watermark)' };
        } catch (_) {}
      }

      // 2. Window globals (TikTok pode setar via JS após carregar o script tag)
      const win = inWindow(
        ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE', '__NEXT_DATA__'],
        ['downloadAddr', 'playAddr'],
      );
      if (win) return { url: win.url, info: win.source };

      // 3. API interna /api/item/detail/ — usa cookies da sessão (mesmo mecanismo do Instagram)
      const videoId = location.pathname.match(/\/video\/(\d+)/)?.[1];
      if (videoId) {
        try {
          const qs = new URLSearchParams({
            itemId: videoId, aid: '1988', app_name: 'tiktok_web',
            device_platform: 'web_pc', browser_language: navigator.language,
          });
          const resp = await fetch(`https://www.tiktok.com/api/item/detail/?${qs}`, {
            credentials: 'include',
            headers: { 'Referer': location.href },
          });
          if (resp.ok) {
            const data = await resp.json();
            const video = data?.itemInfo?.itemStruct?.video;
            const url = video?.downloadAddr || video?.playAddr;
            if (url) return { url, info: 'API TikTok' };
          }
        } catch (_) {}
      }

      // 4. Performance API — TikTok serve MP4 direto (não segmentado), aparece aqui após play
      try {
        const vids = performance.getEntriesByType('resource').filter(e =>
          (e.name.includes('tiktok') || e.name.includes('tiktokcdn') || e.name.includes('tiktokv')) &&
          (e.name.includes('.mp4') || e.name.includes('mime_type=video'))
        );
        if (vids.length) return { url: vids[vids.length - 1].name, info: 'Performance API' };
      } catch (_) {}

      const vtag = fromVideoTag();
      if (vtag) return { url: vtag, info: 'video element' };

      return { url: null, hint: 'Abra o vídeo individualmente e aguarde carregar.' };
    },

    'reddit.com': async function () {
      // Extrai o video ID de v.redd.it e retorna URLs de vídeo + áudio separados
      function redditResult(videoUrl, source) {
        const videoId = videoUrl.match(/v\.redd\.it\/([a-z0-9]+)\//i)?.[1];
        const audioUrl = videoId ? `https://v.redd.it/${videoId}/CMAF_AUDIO_128.mp4` : null;
        return { url: videoUrl, audioUrl, info: source + (audioUrl ? ' — merge automático' : '') };
      }

      // 1. shreddit-player — componente web presente na página renderizada no browser
      const shreddit = document.querySelector('shreddit-player');
      if (shreddit) {
        try {
          const data = JSON.parse(shreddit.getAttribute('packaged-media-json') || '{}');
          const sources = data?.playbackMp4s?.permutations || [];
          const best = sources.sort((a, b) => (b.data?.bitrate ?? 0) - (a.data?.bitrate ?? 0))[0];
          const url = best?.data?.stream?.baseUrl;
          if (url) return redditResult(url, 'shreddit-player');
        } catch (_) {}
      }

      // 2. Fetch .json — API pública do Reddit que funciona com cookies da sessão
      //    Reddit bloqueia curl mas não bloqueia fetch do browser logado
      try {
        const jsonUrl = location.origin + location.pathname.replace(/\/+$/, '') + '.json?limit=1';
        const resp = await fetch(jsonUrl, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        });
        if (resp.ok) {
          const data = await resp.json();
          const post = data?.[0]?.data?.children?.[0]?.data;
          const rv = post?.media?.reddit_video || post?.secure_media?.reddit_video;
          if (rv?.fallback_url) return redditResult(rv.fallback_url, 'Reddit API');

          // Crosspost: o vídeo pode estar no post original
          const xpost = post?.crosspost_parent_list?.[0];
          const xrv = xpost?.media?.reddit_video || xpost?.secure_media?.reddit_video;
          if (xrv?.fallback_url) return redditResult(xrv.fallback_url, 'Reddit API (crosspost)');
        }
      } catch (_) {}

      // 3. Fallbacks via HTML (funcionam quando o extractor roda após renderização)
      const fromScript = inScripts(/"fallback_url":"(https:\/\/v\.redd\.it\/[^"]+)"/);
      if (fromScript) return redditResult(fromScript, 'script JSON');

      const vreddit = inHTML(/https:\/\/v\.redd\.it\/[a-z0-9]+\/(?:DASH|CMAF)_[^"'\s\\&]+\.mp4/i);
      if (vreddit) return redditResult(vreddit, 'HTML');

      const vtag = fromVideoTag();
      if (vtag) return { url: vtag, info: 'video element' };

      return { url: null, hint: 'Abra o post individualmente (não o feed). Reddit requer login para alguns subs.' };
    },

    'twitter.com': extractTwitter,
    'x.com': extractTwitter,

    // Pinterest: API /resource/PinResource/get/ com cookies da sessão.
    // Funciona em qualquer subdomínio regional (br.pinterest.com, etc.)
    // via same-origin fetch usando location.host.
    'pinterest.com': async function () {
      const pinId = location.pathname.match(/\/pin\/(\d+)/)?.[1];
      if (!pinId) return { url: null, hint: 'Abra o pin individualmente (pinterest.com/pin/ID/).' };

      try {
        const params = new URLSearchParams({
          data: JSON.stringify({ options: { id: pinId, field_set_key: 'unauth_react_main_pin' } }),
        });
        const resp = await fetch(
          `${location.protocol}//${location.host}/resource/PinResource/get/?${params}`,
          {
            credentials: 'include',
            headers: {
              'X-Pinterest-PWS-Handler': 'www/pin.js',
              'X-Requested-With': 'XMLHttpRequest',
              'Accept': 'application/json',
            },
          }
        );
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        const json = await resp.json();
        const data = json?.resource_response?.data;
        if (!data) throw new Error('Resposta vazia');

        // Pins normais: data.videos.video_list
        // Story pins:   data.story_pin_data.pages[].blocks[].video.video_list
        const videoList =
          data?.videos?.video_list ??
          data?.story_pin_data?.pages
            ?.flatMap(p => p.blocks ?? [])
            ?.find(b => b?.video?.video_list)
            ?.video?.video_list;

        if (!videoList || !Object.keys(videoList).length)
          return { url: null, hint: 'Este pin não contém vídeo nativo (pode ser embed de outro site).' };

        // Separa MP4 diretos de HLS; ordena por resolução
        const all = Object.entries(videoList)
          .filter(([, f]) => f?.url)
          .map(([id, f]) => ({ id, url: f.url, px: (f.width ?? 0) * (f.height ?? 0), w: f.width, h: f.height }));

        const mp4s = all.filter(f => !f.id.toLowerCase().includes('hls'));
        const pick = mp4s.length ? mp4s : all; // fallback para HLS se não houver MP4
        const best = pick.sort((a, b) => b.px - a.px)[0];
        const isHLS = !mp4s.length;
        const dim = best.w && best.h ? ` ${best.w}×${best.h}` : '';

        return { url: best.url, info: `Pinterest${dim}`, isHLS };
      } catch (e) {
        return { url: null, hint: `Erro na API do Pinterest: ${e.message}` };
      }
    },
  };

  async function extractTwitter() {
    const tweetId = location.pathname.match(/\/status\/(\d+)/)?.[1];
    if (!tweetId) return { url: null, hint: 'Abra o tweet individualmente (x.com/user/status/ID).' };

    // CSRF token — obrigatório; deve bater com o cookie ct0
    const ct0 = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1];
    if (!ct0) return { url: null, hint: 'Cookie ct0 não encontrado. Você precisa estar logado no X.' };

    const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

    // QueryId muda a cada deploy do X — tenta extrair do main.js dinamicamente,
    // com fallback para o último valor conhecido.
    let queryId = 'I9GDzyCGZL2wSoYFFrrTVw';
    try {
      const mainJs = [...document.querySelectorAll('link[rel="preload"][as="script"], script[src]')]
        .map(el => el.href || el.src)
        .find(s => s && /main\.[a-f0-9]+\.js/.test(s));
      if (mainJs) {
        const js = await fetch(mainJs).then(r => r.text());
        const m = js.match(/queryId:"([^"]+)",operationName:"TweetResultByRestId"/);
        if (m) queryId = m[1];
      }
    } catch (_) {}

    const vars = JSON.stringify({ tweetId, withCommunity: false, includePromotedContent: false, withVoice: false });
    const features = JSON.stringify({
      creator_subscriptions_tweet_preview_api_enabled: true,
      tweetypie_unmention_optimization_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    });

    try {
      const url = `https://api.x.com/graphql/${queryId}/TweetResultByRestId?variables=${encodeURIComponent(vars)}&features=${encodeURIComponent(features)}`;
      const resp = await fetch(url, {
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${BEARER}`,
          'x-csrf-token': ct0,
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
        },
      });

      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();

      // O resultado pode estar embrulhado em TweetWithVisibilityResults
      let result = json?.data?.tweetResult?.result;
      if (result?.__typename === 'TweetWithVisibilityResults') result = result.tweet;

      const media = result?.legacy?.extended_entities?.media ?? [];
      const videoMedia = media.find(m => m.type === 'video' || m.type === 'animated_gif');
      if (!videoMedia) return { url: null, hint: 'Este tweet não contém vídeo.' };

      // Filtra só MP4, ordena por bitrate e pega o melhor
      const best = (videoMedia.video_info?.variants ?? [])
        .filter(v => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];

      if (!best) return { url: null, hint: 'Nenhum MP4 encontrado (pode ser só HLS).' };

      const dim = best.url.match(/\/(\d+x\d+)\//)?.[1] ?? '';
      return { url: best.url, info: `API X GraphQL${dim ? ' ' + dim : ''}` };

    } catch (e) {
      return { url: null, hint: `Erro na API do X: ${e.message}. Tente recarregar a página.` };
    }
  }

  /* ─── Detecção e extração ─── */

  const host = location.hostname;
  const platformKey = Object.keys(extractors).find(k => host.includes(k));

  const {
    url = null,
    info = '',
    hint = '',
    isHLS = false,
    audioUrl = null,
  } = await (platformKey
    ? extractors[platformKey]()
    : Promise.resolve({ url: null, info: 'Site não suportado' }));

  /* ─── Render UI (DOM puro — compatível com Trusted Types CSP do YouTube) ─── */

  // Limpa o placeholder de loading
  while (el.firstChild) el.removeChild(el.firstChild);

  // CSS via textContent (não é um sink de Trusted Types)
  const styleEl = document.createElement('style');
  styleEl.textContent = [
    `#${ID}{position:fixed;top:16px;right:16px;z-index:2147483647;width:330px;`,
    `background:#0f172a;color:#e2e8f0;border-radius:16px;border:1px solid #1e293b;`,
    `box-shadow:0 24px 64px rgba(0,0,0,.7);font-family:system-ui,-apple-system,sans-serif;`,
    `font-size:13px;overflow:hidden}`,
    `#${ID} *{box-sizing:border-box;margin:0;padding:0}`,
    `#${ID} .hd{padding:13px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1e293b}`,
    `#${ID} .title{font-weight:700;font-size:14px;color:#f1f5f9;letter-spacing:.01em}`,
    `#${ID} .x{background:none;border:none;color:#64748b;font-size:22px;cursor:pointer;`,
    `width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:6px;line-height:1}`,
    `#${ID} .x:hover{background:#1e293b;color:#f1f5f9}`,
    `#${ID} .bd{padding:14px 16px}`,
    `#${ID} .status{display:flex;align-items:center;gap:7px;margin-bottom:10px;color:#94a3b8}`,
    `#${ID} .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}`,
    `#${ID} .ok{background:#10b981}#${ID} .err{background:#ef4444}`,
    `#${ID} .urlbox{background:#1e293b;border:1px solid #334155;border-radius:8px;`,
    `padding:8px 10px;font-size:11px;color:#94a3b8;word-break:break-all;`,
    `max-height:58px;overflow-y:auto;margin-bottom:12px;line-height:1.5}`,
    `#${ID} .btns{display:flex;gap:8px}`,
    `#${ID} .btn{flex:1;padding:10px 8px;border-radius:10px;border:none;font-size:13px;`,
    `font-weight:600;cursor:pointer;text-align:center;display:block;line-height:1.3;transition:filter .15s}`,
    `#${ID} .btn:hover{filter:brightness(1.15)}`,
    `#${ID} .bdl{background:#059669;color:#fff}`,
    `#${ID} .bcp{background:#2563eb;color:#fff}`,
    `#${ID} .warn{background:#422006;border:1px solid #92400e;border-radius:8px;`,
    `padding:9px 11px;font-size:11px;color:#fbbf24;margin-bottom:10px;line-height:1.6;white-space:pre-line}`,
    `#${ID} .hint{font-size:11px;color:#64748b;margin-top:8px;line-height:1.6}`,
  ].join('');
  el.appendChild(styleEl);

  // Header
  const hdEl = document.createElement('div');
  hdEl.className = 'hd';
  const titleEl = document.createElement('span');
  titleEl.className = 'title';
  titleEl.textContent = '⬇ Video Downloader';
  const xBtnEl = document.createElement('button');
  xBtnEl.className = 'x';
  xBtnEl.id = `${ID}-x`;
  xBtnEl.textContent = '×';
  hdEl.appendChild(titleEl);
  hdEl.appendChild(xBtnEl);
  el.appendChild(hdEl);

  // Body
  const bdEl = document.createElement('div');
  bdEl.className = 'bd';

  if (url) {
    // Status OK
    const statusEl = document.createElement('div');
    statusEl.className = 'status';
    const dotEl = document.createElement('span');
    dotEl.className = 'dot ok';
    const stTxt = document.createElement('span');
    stTxt.appendChild(document.createTextNode('Encontrado — '));
    const emEl = document.createElement('em');
    emEl.textContent = info;
    stTxt.appendChild(emEl);
    statusEl.appendChild(dotEl);
    statusEl.appendChild(stTxt);
    bdEl.appendChild(statusEl);

    // Aviso HLS
    if (isHLS) {
      const wEl = document.createElement('div');
      wEl.className = 'warn';
      wEl.textContent = '⚠ Stream HLS (.m3u8) — não baixa direto no browser.\nCopie a URL e use:\nffmpeg -i "URL" -c copy out.mp4\nou abra no VLC → Abrir URL de rede.';
      bdEl.appendChild(wEl);
    }

    // Aviso extra (hint com URL válida)
    if (hint) {
      const wEl = document.createElement('div');
      wEl.className = 'warn';
      wEl.textContent = hint;
      bdEl.appendChild(wEl);
    }

    // URL box
    const urlBoxEl = document.createElement('div');
    urlBoxEl.className = 'urlbox';
    urlBoxEl.textContent = url;
    bdEl.appendChild(urlBoxEl);

    // Botões
    const btnsEl = document.createElement('div');
    btnsEl.className = 'btns';
    if (!isHLS) {
      const dlBtnEl = document.createElement('button');
      dlBtnEl.className = 'btn bdl';
      dlBtnEl.id = `${ID}-dl`;
      dlBtnEl.textContent = '⬇ Baixar';
      btnsEl.appendChild(dlBtnEl);
    }
    if (!audioUrl) {
      const cpBtnEl = document.createElement('button');
      cpBtnEl.className = `btn bcp${isHLS ? ' bdl' : ''}`;
      cpBtnEl.id = `${ID}-cp`;
      cpBtnEl.textContent = '📋 Copiar URL';
      btnsEl.appendChild(cpBtnEl);
    }
    bdEl.appendChild(btnsEl);
  } else {
    // Status erro
    const statusEl = document.createElement('div');
    statusEl.className = 'status';
    const dotEl = document.createElement('span');
    dotEl.className = 'dot err';
    const stTxt = document.createElement('span');
    stTxt.textContent = info || 'Nenhum vídeo encontrado';
    statusEl.appendChild(dotEl);
    statusEl.appendChild(stTxt);
    bdEl.appendChild(statusEl);

    if (hint) {
      const hintEl = document.createElement('div');
      hintEl.className = 'hint';
      hintEl.textContent = '💡 ' + hint;
      bdEl.appendChild(hintEl);
    }
  }

  el.appendChild(bdEl);

  document.getElementById(`${ID}-x`).addEventListener('click', () => el.remove());

  // ── Copiar URL
  const cpBtn = document.getElementById(`${ID}-cp`);
  if (cpBtn) {
    cpBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); }
      catch (_) {
        const ta = Object.assign(document.createElement('textarea'), { value: url });
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      const orig = cpBtn.textContent;
      cpBtn.textContent = '✓ Copiado!';
      setTimeout(() => (cpBtn.textContent = orig), 2500);
    });
  }

  // ── Baixar
  const dlBtn = document.getElementById(`${ID}-dl`);
  if (dlBtn) {
    dlBtn.addEventListener('click', async () => {
      dlBtn.textContent = '⏳ Baixando…';
      try {
        let buf;
        if (audioUrl) {
          // Baixa vídeo+áudio separados (Reddit, YouTube 1080p+) e faz merge em memória
          buf = await mergeRedditMP4(url, audioUrl, msg => { dlBtn.textContent = `⏳ ${msg}`; });
        } else {
          // googlevideo.com usa CORS com credenciais quando o player faz Range requests.
          // 1ª tentativa: credentials:'include' (envia cookies do YouTube — necessário para rqh=1)
          // 2ª tentativa: credentials:'omit' (CDNs públicos como v.redd.it, Pinterest)
          let resp;
          try {
            resp = await fetch(url, { mode: 'cors', credentials: 'include', headers: { 'Range': 'bytes=0-' } });
          } catch (_) {
            resp = await fetch(url, { mode: 'cors', credentials: 'omit', headers: { 'Range': 'bytes=0-' } });
          }
          if (!resp.ok && resp.status !== 206) throw new Error('HTTP ' + resp.status);
          buf = await resp.arrayBuffer();
        }
        const burl = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
        const a = Object.assign(document.createElement('a'), { href: burl, download: 'video.mp4' });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(burl), 60000);
        dlBtn.textContent = '✓ Pronto!';
      } catch (e) {
        console.error('[VDL]', e);
        window.open(url, '_blank');
        dlBtn.textContent = '↗ Nova aba';
      }
      setTimeout(() => (dlBtn.textContent = '⬇ Baixar'), 3500);
    });
  }
})();
