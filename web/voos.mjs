// ── Busca de passagens aéreas ────────────────────────────────────────────────
// Uma tool: `buscar_voos`. Fonte = Google Flights via SerpApi (mesma chave que
// já serve o google_lens da busca por imagem). Duas coisas ficam NOSSAS e são o
// que faz a feature aguentar escala:
//
//  1) CACHE (mtr_harness.flight_searches): a franquia de busca é o recurso
//     escasso, e a mesma rota/data é reconsultada muito (a pessoa pergunta de
//     novo, uma rotina de monitoramento roda todo dia). A resposta crua é
//     guardada por FLIGHT_CACHE_MIN minutos, chaveada por hash dos parâmetros
//     normalizados — então o cache é compartilhado entre usuários (ninguém
//     "possui" o preço de um voo). Quando a API falha, servimos o cache VELHO
//     dizendo a idade dele, em vez de mentir ou não responder.
//
//  2) HISTÓRICO (mtr_harness.flight_prices): cada busca real grava o menor
//     preço observado. Com o tempo isso vira base própria pra dizer "é bom
//     preço" no mercado BR, sem depender do price_insights de terceiro (que só
//     vem em algumas rotas). Hoje o veredito usa os dois: o que a fonte informa
//     e o que a gente mesmo mediu.
//
// NÃO fecha compra: a venda de bilhete exige acreditação (ver
// projetos/compra-vtex-agente.md pro caso de e-commerce e o doc de voos pro
// porquê da Duffel). A tool entrega o deep link do Google Flights pro dono
// fechar onde quiser.
//
// Custo: cada busca REAL reporta um usage (model 'serpapi-flights') via
// onUsage; quem cobra é o server (recordUsages), com a mesma franquia grátis
// mensal que o Tavily tem. Cache hit não reporta nada (não custou nada).

import { createHash } from 'node:crypto';
import {
  getFlightCache, putFlightCache, recordFlightPrice, flightPriceStats,
} from './db.mjs';
import { marca } from './marca.mjs';

const CACHE_MIN = Number(process.env.FLIGHT_CACHE_MIN || 180); // 3h

export function voosEnabled() { return !!process.env.SERPAPI_KEY; }

// Apelidos de cidade → aeroporto principal. Só o que o brasileiro digita no
// chat; o modelo já sabe código IATA e a descrição da tool pede o código. Isto
// é rede de segurança pra "voo de são paulo pra lisboa", não um catálogo.
const APELIDOS = {
  'sao paulo': 'GRU', 'são paulo': 'GRU', sp: 'GRU', sampa: 'GRU', guarulhos: 'GRU',
  congonhas: 'CGH', viracopos: 'VCP', campinas: 'VCP',
  'rio de janeiro': 'GIG', rio: 'GIG', galeao: 'GIG', galeão: 'GIG', santos_dumont: 'SDU',
  'belo horizonte': 'CNF', bh: 'CNF', confins: 'CNF',
  brasilia: 'BSB', brasília: 'BSB', salvador: 'SSA', recife: 'REC', fortaleza: 'FOR',
  'porto alegre': 'POA', curitiba: 'CWB', florianopolis: 'FLN', florianópolis: 'FLN',
  vitoria: 'VIX', vitória: 'VIX', natal: 'NAT', maceio: 'MCZ', maceió: 'MCZ',
  'joao pessoa': 'JPA', 'joão pessoa': 'JPA', aracaju: 'AJU', teresina: 'THE',
  'sao luis': 'SLZ', 'são luís': 'SLZ', belem: 'BEL', belém: 'BEL', manaus: 'MAO',
  'campo grande': 'CGR', cuiaba: 'CGB', cuiabá: 'CGB', goiania: 'GYN', goiânia: 'GYN',
  'porto velho': 'PVH', 'rio branco': 'RBR', 'boa vista': 'BVB', macapa: 'MCP', macapá: 'MCP',
  palmas: 'PMW', 'foz do iguacu': 'IGU', 'foz do iguaçu': 'IGU', 'porto seguro': 'BPS',
  ilheus: 'IOS', ilhéus: 'IOS', 'navegantes': 'NVT', 'ribeirao preto': 'RAO',
  'nova york': 'JFK', 'new york': 'JFK', 'nova iorque': 'JFK',
  miami: 'MIA', orlando: 'MCO', 'los angeles': 'LAX', chicago: 'ORD', boston: 'BOS',
  lisboa: 'LIS', porto: 'OPO', madri: 'MAD', madrid: 'MAD', barcelona: 'BCN',
  paris: 'CDG', londres: 'LHR', roma: 'FCO', milao: 'MXP', milão: 'MXP',
  amsterda: 'AMS', amsterdã: 'AMS', frankfurt: 'FRA', munique: 'MUC', zurique: 'ZRH',
  'buenos aires': 'EZE', santiago: 'SCL', montevideu: 'MVD', lima: 'LIM',
  bogota: 'BOG', bogotá: 'BOG', 'cidade do mexico': 'MEX', cancun: 'CUN', cancún: 'CUN',
  toquio: 'HND', tóquio: 'HND', dubai: 'DXB', doha: 'DOH', 'cidade do cabo': 'CPT',
  joanesburgo: 'JNB', sydney: 'SYD', toronto: 'YYZ', 'panama': 'PTY', 'panamá': 'PTY',
};

function resolveAeroporto(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
  const k = s.toLowerCase().replace(/\s+/g, ' ');
  return APELIDOS[k] || APELIDOS[k.replace(/ /g, '_')] || null;
}

const CLASSES = { economica: 1, econômica: 1, premium: 2, executiva: 3, primeira: 4 };
const PARADAS = { qualquer: 0, direto: 1, '1_parada': 2, '2_paradas': 3 };

function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

const brl = (n, cur = 'BRL') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '?';
  const pre = cur === 'BRL' ? 'R$ ' : `${cur} `;
  return pre + v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
};

const dur = (min) => {
  const m = Number(min) || 0;
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, '0')}` : `${m}min`;
};

const hora = (s) => String(s || '').slice(11, 16);

// Uma opção de voo em uma linha.
function linhaVoo(o, i, cur) {
  const pernas = o.flights || [];
  const p0 = pernas[0] || {};
  const pN = pernas[pernas.length - 1] || {};
  const cias = [...new Set(pernas.map((f) => f.airline).filter(Boolean))].join(' + ');
  const paradas = (o.layovers || []).length;
  const escalas = paradas
    ? `${paradas} parada${paradas > 1 ? 's' : ''} (${(o.layovers || []).map((l) => `${l.id} ${dur(l.duration)}`).join(', ')})`
    : 'direto';
  const saiu = hora(p0.departure_airport?.time);
  const chegou = hora(pN.arrival_airport?.time);
  const departureDate = String(p0.departure_airport?.time || '').slice(0, 10);
  const arrivalDate = String(pN.arrival_airport?.time || '').slice(0, 10);
  const arrivalSuffix = arrivalDate && arrivalDate !== departureDate ? ` (${arrivalDate})` : '';
  const rota = `${p0.departure_airport?.id || '?'}→${pN.arrival_airport?.id || '?'}`;
  const numeros = pernas.map(f => f.flight_number).filter(Boolean).join(' / ');
  return `${i}) ${brl(o.price, cur)} · ${cias || '?'}${numeros ? ` (${numeros})` : ''} · ${rota} ${saiu}–${chegou}${arrivalSuffix} · ${dur(o.total_duration)} · ${escalas}`;
}

function bagagemObservada(option) {
  // Keep the exact airline/search statement. A cabin label or absent field is
  // never evidence that checked baggage is excluded or included.
  const notes = [...(option?.extensions || []), ...(option?.flights || []).flatMap(f => f.extensions || [])]
    .filter(note => typeof note === 'string' && /bag|baggage|luggage|mala|equipaje/i.test(note));
  return notes.length ? `Bagagem — informação da fonte: ${[...new Set(notes)].join('; ')}. Quantidade, peso e eventual custo da mala despachada só estão confirmados se explícitos nessa informação.`
    : 'Bagagem despachada: franquia e custo não informados pela fonte para esta oferta.';
}

export const FLIGHT_ANSWER_CONTRACT = 'Compare itinerários concretos: cada opção deve conter uma ida e uma volta vinculadas pela fonte, aeroportos, datas e horários. Não agrupe horários alternativos como uma única opção nem invente a volta. Preço inicial de ida e volta não comprova um retorno escolhido. Não afirme tarifa sem bagagem só porque a cabine é econômica. Não acrescente taxas genéricas de artigos a uma oferta como se fossem cotação. Se faltar franquia/custo ou unidade do preço, informe o que não foi confirmado e não anuncie total fechado com malas. Preserve passageiros, datas, aeroportos e restrições do pedido até o link final. Compare médias somente quando tiver amostra comparável; não misture períodos, passageiros, tipo de viagem ou cabine.';

// Veredito de preço: o que a fonte informa (price_insights) + o que NÓS medimos
// (flight_prices). Nunca afirma sem base: sem os dois, diz que não tem base.
function veredito(insights, stats, menor, cur) {
  const partes = [];
  const nivel = { low: 'ABAIXO do normal', typical: 'na média', high: 'ACIMA do normal' };
  if (insights?.price_level && nivel[insights.price_level]) {
    let t = `Google Flights: preço ${nivel[insights.price_level]} pra essa rota`;
    const [lo, hi] = insights.typical_price_range || [];
    if (lo && hi) t += ` (faixa típica ${brl(lo, cur)}–${brl(hi, cur)})`;
    partes.push(t);
  }
  if (stats) {
    const rel = menor <= stats.p25 ? 'entre os mais baratos que já vimos'
      : menor >= stats.avg ? 'acima da nossa média' : 'abaixo da nossa média';
    partes.push(`Nosso histórico (${stats.n} medições/${stats.days}d): média ${brl(stats.avg, cur)}, mínimo ${brl(stats.min, cur)} — este está ${rel}`);
  }
  if (!partes.length) return 'Sem base pra dizer se é bom preço nessa rota ainda (a fonte não trouxe faixa típica e é a primeira vez que medimos). Buscando de novo em outros dias eu passo a ter comparação.';
  return partes.join('. ') + '.';
}

export function voosTools(userId, agentId, { onUsage = () => {}, onObservation = null, fresh = false } = {}) {
  return [{
    name: 'buscar_voos',
    description: 'Searches airline tickets (Google Flights), with price, airline, times and layovers. For round trips, queries linked returns for up to three options. Returns a link to check and buy; does NOT buy the ticket. Prefer 3-letter IATA codes. ' + FLIGHT_ANSWER_CONTRACT,
    parameters: {
      type: 'object',
      properties: {
        origem: { type: 'string', description: 'Origin airport (3-letter IATA, e.g. GRU) or city.' },
        destino: { type: 'string', description: 'Destination airport (3-letter IATA) or city.' },
        data_ida: { type: 'string', description: 'Departure date in YYYY-MM-DD format.' },
        data_volta: { type: 'string', description: 'Return date YYYY-MM-DD. Omit for one-way.' },
        adultos: { type: 'integer', description: 'Adults (default 1).' },
        criancas: { type: 'integer', description: 'Children (default 0).' },
        classe: { type: 'string', enum: ['economica', 'premium', 'executiva', 'primeira'], description: 'Cabin class (default economica).' },
        paradas: { type: 'string', enum: ['qualquer', 'direto', '1_parada'], description: 'Layover filter (default qualquer).' },
        companhias: { type: 'array', items: {type:'string'}, maxItems:5, description:'IATA codes of the allowed airlines, when the user restricts the search. Do not invent filters.' },
        max_preco: { type: 'integer', description: 'Price ceiling in BRL, if the owner gave a limit.' },
        malas_despachadas_por_pessoa: { type: 'integer', minimum: 0, maximum: 5, description: 'Number required by the user; preserve the requirement. The source may not report allowance/fee. Do not convert this into the bags filter, which refers to carry-on baggage.' },
      },
      required: ['origem', 'destino', 'data_ida'],
    },
    run: async (a) => {
      if (!voosEnabled()) return `A busca de voos não está configurada neste ambiente (falta a chave da fonte de busca). Avise o time do ${marca().nome}.`;

      const org = resolveAeroporto(a.origem);
      const dst = resolveAeroporto(a.destino);
      if (!org || !dst) {
        return `Não reconheci ${!org ? `a origem "${a.origem}"` : `o destino "${a.destino}"`}. Passe o código IATA de 3 letras do aeroporto (ex: GRU, GIG, LIS).`;
      }
      if (!isDate(a.data_ida)) return 'Passe a data de ida no formato AAAA-MM-DD.';
      if (a.data_volta && !isDate(a.data_volta)) return 'Passe a data de volta no formato AAAA-MM-DD.';

      let companhias;
      if (a.companhias !== undefined) {
        if (!Array.isArray(a.companhias) || !a.companhias.length || a.companhias.length>5 || a.companhias.some(v=>typeof v!=='string'||!/^(?:[A-Z][A-Z0-9]|[0-9][A-Z])$/.test(v))) return 'Filtro de companhia inválido: use códigos IATA de dois caracteres.';
        companhias=[...new Set(a.companhias)].sort();
      }
      const adultos = Math.max(1, Math.min(9, Number(a.adultos) || 1));
      const criancas = Math.max(0, Math.min(8, Number(a.criancas) || 0));
      const classeKey = String(a.classe || 'economica').toLowerCase();
      const classe = CLASSES[classeKey] || 1;
      const paradasKey = String(a.paradas || 'qualquer').toLowerCase();
      const paradas = PARADAS[paradasKey] ?? 0;
      const tipo = a.data_volta ? 1 : 2; // 1=ida e volta, 2=só ida

      const q = {
        engine: 'google_flights',
        departure_id: org,
        arrival_id: dst,
        outbound_date: a.data_ida,
        ...(a.data_volta ? { return_date: a.data_volta } : {}),
        type: String(tipo),
        adults: String(adultos),
        ...(criancas ? { children: String(criancas) } : {}),
        travel_class: String(classe),
        ...(paradas ? { stops: String(paradas) } : {}),
        ...(companhias ? {include_airlines:companhias.join(',')} : {}),
        ...(a.max_preco ? { max_price: String(Math.round(a.max_preco)) } : {}),
        currency: 'BRL',
        hl: 'pt-br',
        gl: 'br',
      };
      // Chave de cache = parâmetros normalizados (sem a api_key). Estável entre
      // usuários de propósito: preço de voo não é dado de ninguém.
      const cacheKey = createHash('sha256').update(JSON.stringify(q)).digest('hex').slice(0, 40);

      let data = null;
      let idadeCache = null;
      const hit = fresh ? null : await getFlightCache(cacheKey, CACHE_MIN).catch(() => null);
      if (hit && !hit.stale) { data = hit.payload; idadeCache = hit.ageMin; }

      let buscouAgora = false;
      if (!data) {
        const url = 'https://serpapi.com/search.json?' +
          new URLSearchParams({ ...q, ...(fresh ? {no_cache:'true'} : {}), api_key: process.env.SERPAPI_KEY }).toString();
        let erro = null;
        // Fresh não repete request incerto: cada tentativa pode custar créditos.
        for (let i = 0; i < (fresh ? 1 : 3); i++) {
          try {
            const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
            const j = await r.json().catch(() => null);
            if (j?.error) { erro = j.error; break; }         // erro de parâmetro: não insiste
            if (!r.ok) { erro = `HTTP ${r.status}`; await sleep(1200); continue; }
            data = j; buscouAgora = true; break;
          } catch (e) { erro = e?.message || String(e); await sleep(1200); }
        }
        if (!data) {
          // Fonte fora do ar: serve o cache velho DIZENDO a idade, ou admite.
          if (hit?.payload) { data = hit.payload; idadeCache = hit.ageMin; }
          else return `Não consegui consultar os voos agora (${erro || 'falha na fonte'}). Tento de novo se você quiser.`;
        }
      }

      const seenOptions = new Set();
      const opcoes = [...(data.best_flights || []), ...(data.other_flights || [])].filter(option => {
        if (!Number.isFinite(Number(option.price)) || Number(option.price) <= 0 || !option.flights?.length) return false;
        const key = JSON.stringify([option.price, option.flights]);
        if (seenOptions.has(key)) return false;
        seenOptions.add(key); return true;
      });
      if (!opcoes.length) {
        const msg = data.error ? ` (${data.error})` : '';
        return `A fonte não retornou voo pra ${org}→${dst} em ${a.data_ida}${a.data_volta ? ` (volta ${a.data_volta})` : ''}${msg}. Vale checar se as datas e os aeroportos estão certos, ou tentar uma data vizinha.`;
      }

      const cur = data.search_parameters?.currency || 'BRL';
      opcoes.sort((x, y) => (Number(x.price) || 1e9) - (Number(y.price) || 1e9));
      const top = opcoes.slice(0, 5);
      const menor = Number(top[0]?.price) || null;
      const insights = data.price_insights || null;

      // Só busca REAL alimenta o histórico e a cobrança (cache hit não custou).
      if (buscouAgora) {
        await putFlightCache(cacheKey, {
          origin: org, destination: dst, departDate: a.data_ida,
          returnDate: a.data_volta || null, params: q, payload: data,
        }).catch(() => {});
        if (menor) {
          const cias = (top[0].flights || []).map((f) => f.airline).filter(Boolean);
          await recordFlightPrice({
            origin: org, destination: dst, departDate: a.data_ida,
            returnDate: a.data_volta || null,
            trip: a.data_volta ? 'round' : 'oneway',
            cabin: classeKey, stops: paradasKey,
            price: menor, currency: cur, airline: cias[0] || '',
            priceLevel: insights?.price_level || '',
            typicalLow: insights?.typical_price_range?.[0] ?? null,
            typicalHigh: insights?.typical_price_range?.[1] ?? null,
          }).catch(() => {});
        }
        try {
          onUsage({
            usage: { model: 'serpapi-flights', in: 0, cached: 0, out: 1, think: 0, total: 1 },
            kind: 'search',
          });
        } catch {}
      }

      // Canal interno de dados tipados: só observações da fonte, nunca texto do LLM.
      // Cache preserva o timestamp original, inclusive no fallback antigo.
      if (onObservation) await onObservation({
        price: menor, currency: cur,
        observedAt: fresh ? data.search_metadata?.created_at : buscouAgora ? new Date().toISOString() : hit?.fetchedAt,
        freshRequested: fresh === true,
        fromCache: !buscouAgora, stale: !buscouAgora && !!hit?.stale,
        link: data.search_metadata?.google_flights_url || '',
        options: top.slice(0,3).map(o => ({price: Number(o.price),
          airline: [...new Set((o.flights||[]).map(f=>f.airline).filter(Boolean))].join(' + '),
          stops: (o.layovers||[]).length})),
      });
      // The legacy history mixes dates, passenger counts and round/one-way.
      // It remains recorded for existing monitoring, but is not a defensible
      // comparison for a conversational quote. Use source insights only.
      const stats = onObservation ? await flightPriceStats(org, dst, { cabin: classeKey }).catch(() => null) : null;
      const link = data.search_metadata?.google_flights_url || '';

      // Google Flights' first response only contains outbound flights. Resolve
      // each chosen outbound with its own token; never join unrelated cheap
      // outbound/return results into an invented round-trip price.
      // Scheduled monitors need only a price observation, not extra searches.
      const returns = a.data_volta && !onObservation ? await Promise.all(top.slice(0, 3).map(async outbound => {
        if (!outbound.departure_token) return { reason: 'A fonte não forneceu referência para consultar a volta desta ida.' };
        const params = { ...q, departure_token: outbound.departure_token };
        const key = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 40);
        let payload = null;
        const cached = fresh ? null : await getFlightCache(key, CACHE_MIN).catch(() => null);
        if (cached && !cached.stale) payload = cached.payload;
        if (!payload) {
          try {
            const response = await fetch('https://serpapi.com/search.json?' + new URLSearchParams({ ...params,
              ...(fresh ? { no_cache: 'true' } : {}), api_key: process.env.SERPAPI_KEY }), { signal: AbortSignal.timeout(30000) });
            payload = await response.json();
            if (!response.ok || payload?.error) return { reason: 'A consulta de volta desta opção falhou; o itinerário não está completo.' };
            try { onUsage({ usage: { model: 'serpapi-flights', in: 0, cached: 0, out: 1, think: 0, total: 1 }, kind: 'search' }); } catch {}
            await putFlightCache(key, { origin: org, destination: dst, departDate: a.data_ida,
              returnDate: a.data_volta, params, payload }).catch(() => {});
          } catch { return { reason: 'A consulta de volta desta opção falhou; o itinerário não está completo.' }; }
        }
        if (payload?.search_parameters?.currency && payload.search_parameters.currency !== cur) {
          return { reason: 'A fonte retornou a volta em outra moeda; não há preço comparável confirmado.' };
        }
        const candidates = [...(payload?.best_flights || []), ...(payload?.other_flights || [])]
          .filter(o => Number.isFinite(Number(o.price)) && Number(o.price) > 0 &&
            o.flights?.[0]?.departure_airport?.id === dst && o.flights?.at(-1)?.arrival_airport?.id === org &&
            String(o.flights[0].departure_airport?.time || '').slice(0, 10) === a.data_volta)
          .sort((x, y) => Number(x.price) - Number(y.price));
        if (!candidates.length) return { reason: 'Nenhuma volta compatível foi encontrada para esta ida; o itinerário não está completo.' };
        return { option: candidates[0], link: payload.search_metadata?.google_flights_url || link };
      })) : null;

      const cab = { economica: 'econômica', premium: 'premium economy', executiva: 'executiva', primeira: 'primeira classe' }[classeKey] || classeKey;
      const pax = `${adultos} adulto${adultos > 1 ? 's' : ''}${criancas ? ` + ${criancas} criança${criancas > 1 ? 's' : ''}` : ''}`;
      const cabecalho = `${org} → ${dst} · ida ${a.data_ida}${a.data_volta ? ` · volta ${a.data_volta}` : ' · só ida'} · ${pax} · ${cab}${paradasKey !== 'qualquer' ? ` · ${paradasKey.replace('_', ' ')}` : ''}`;

      const out = [
        cabecalho,
        '',
        ...(returns ? top.slice(0, 3).flatMap((o, i) => {
          const found = returns[i];
          return [`Opção ${i + 1}:`, `Ida ${a.data_ida}: ${linhaVoo(o, i + 1, cur).replace(/^\d+\) [^·]+ · /, '')}`,
            found.option ? `Volta ${a.data_volta}: ${linhaVoo(found.option, i + 1, cur).replace(/^\d+\) [^·]+ · /, '')}` : `Volta: ${found.reason}`,
            `Valor observado ${found.option ? 'para esta combinação' : 'na busca inicial, sem volta confirmada'}: ${brl(found.option?.price ?? o.price, cur)}.`,
            `Ida: ${bagagemObservada(o)}`, ...(found.option ? [`Volta: ${bagagemObservada(found.option)}`] : []),
            ...(found.link ? [`Conferir esta combinação: ${found.link}`] : []), ''];
        }) : top.map((o, i) => `${linhaVoo(o, i + 1, cur)}\n${bagagemObservada(o)}`)),
        '',
        veredito(insights, stats, menor, cur),
      ];
      out.push(adultos + criancas === 1
        ? `Valores da busca para um passageiro, ${a.data_volta ? 'ida e volta' : 'só ida'}.`
        : `Valores retornados para uma busca com ${pax}. A API não informa aqui se a unidade é por pessoa ou pelo grupo: não multiplique, divida nem anuncie total fechado sem confirmar essa unidade na oferta.`);
      if (a.malas_despachadas_por_pessoa != null) out.push(`Exigência do pedido: ${a.malas_despachadas_por_pessoa} mala(s) despachada(s) por pessoa. Não confundir com bagagem de mão; falta de franquia/custo explícitos impede confirmar que a oferta cumpre a exigência e seu total.`);
      out.push(FLIGHT_ANSWER_CONTRACT);
      // Idade só aparece quando é informação de verdade: "vistos há 0 min" é
      // ruído, e preço de minutos atrás é o preço de agora.
      if (idadeCache != null && idadeCache >= 10) {
        out.push(idadeCache < 60
          ? `Preços vistos há ${idadeCache} min.`
          : `Preços vistos há ${Math.round(idadeCache / 60)}h (não consultei de novo agora).`);
      }
      if (link) out.push(`Conferir e comprar: ${link}`);
      out.push('Não fecho a compra da passagem; o pagamento é feito nesse link, no site da companhia ou na agência.');
      return out.join('\n');
    },
  }];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
