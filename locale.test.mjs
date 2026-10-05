// Teste offline da regra de idioma/país. Nada sai pra rede, nada toca banco.
// Roda com: node locale.test.mjs
import {
  IDIOMAS_OK, IDIOMA_PADRAO, normalizaIdioma, normalizaPais, localeDoAcceptLanguage,
  tagIdioma, instrucaoDeIdioma, comIdioma, derivaDeIdioma, lembreteDeIdioma,
  ideogramaAcidental, avisoSemIdioma,
} from './web/locale.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };
const idioma = (entrada, esperado) => t(`idioma ${JSON.stringify(entrada)} -> ${esperado}`, normalizaIdioma(entrada) === esperado);
const pais = (entrada, esperado) => t(`país ${JSON.stringify(entrada)} -> ${esperado}`, normalizaPais(entrada) === esperado);
const header = (raw, lang, country) => {
  const r = localeDoAcceptLanguage(raw);
  t(`header ${JSON.stringify(raw)} -> ${lang}/${country}`, r.language === lang && r.country === country);
};

// 0) O conjunto atendido. Se alguém mexer nisso sem traduzir, o teste avisa.
t('idiomas atendidos = pt-BR, en, es', JSON.stringify(IDIOMAS_OK) === JSON.stringify(['pt-BR', 'en', 'es']));
t('padrão é pt-BR', IDIOMA_PADRAO === 'pt-BR');

// 1) normalizaIdioma: variantes regionais colapsam na língua.
idioma('pt', 'pt-BR');
idioma('pt-BR', 'pt-BR');
idioma('pt-br', 'pt-BR');
idioma('PT-PT', 'pt-BR');   // português de Portugal cai no nosso pt-BR: é a mesma tradução
idioma('en', 'en');
idioma('en-US', 'en');
idioma('en-GB', 'en');
idioma('es', 'es');
idioma('es-AR', 'es');
idioma('es-419', 'es');     // espanhol da América Latina
idioma('  ES-mx  ', 'es');  // espaço e caixa não podem atrapalhar

// 2) normalizaIdioma: "não sei" tem que ser null, NUNCA virar pt-BR aqui.
//    Quem decide o fallback é o chamador; misturar as duas coisas apaga a
//    diferença entre "a pessoa escolheu português" e "não faço ideia".
['ja', 'fr', 'de', 'zh-CN', 'xx', '', '   ', null, undefined, 0, {}, 'portugues'].forEach((v) => idioma(v, null));

// 3) normalizaPais: só formato ISO-3166 alfa-2, em maiúscula.
pais('br', 'BR');
pais('BR', 'BR');
pais(' us ', 'US');
pais('ar', 'AR');
['BRA', 'B', '419', '', '1R', null, undefined, 'br1'].forEach((v) => pais(v, null));

// 4) Accept-Language: o caso comum.
header('pt-BR,pt;q=0.9,en-US;q=0.8', 'pt-BR', 'BR');
header('en-US,en;q=0.9', 'en', 'US');
header('es-AR,es;q=0.9,en;q=0.8', 'es', 'AR');
header('es', 'es', null);            // sem região declarada: país fica desconhecido, não chutado
header('pt', 'pt-BR', null);

// 5) Língua que ainda não atendemos é PULADA, não vira padrão. Quem tem o
//    navegador em japonês com inglês em segundo lugar tem que cair em inglês.
header('ja,en;q=0.9', 'en', null);
header('ja-JP,en-GB;q=0.9,pt-BR;q=0.8', 'en', 'GB');
header('fr-FR,de;q=0.9', null, null);   // nada que a gente atenda: chamador decide
header('ja', null, null);

// 6) Ordenação por q, incluindo empate. Empate preserva a ordem declarada
//    (RFC 9110), então "en;q=0.9,es;q=0.9" é inglês.
header('en;q=0.5,es;q=0.9', 'es', null);
header('pt-BR;q=0.2,en-US;q=0.7', 'en', 'US');
header('en;q=0.9,es;q=0.9', 'en', null);
header('es-MX;q=1,en-US', 'es', 'MX');   // sem q explícito vale 1, empata, es vem antes

// 7) Header ausente, vazio ou lixo não pode explodir nem chutar idioma.
[null, undefined, '', '   ', '*', ',,,', ';q=0.9', 'pt;q=abc'].forEach((raw) => {
  const r = localeDoAcceptLanguage(raw);
  t(`header inválido ${JSON.stringify(raw)} não explode`, r && typeof r === 'object' && 'language' in r && 'country' in r);
});
header('*', null, null);
header('pt;q=abc', 'pt-BR', null);   // q ilegível vira 0, mas a língua ainda conta

// 8) tagIdioma: sempre devolve uma das três, com fallback no padrão.
t('tag pt-BR', tagIdioma('pt-BR') === 'pt-BR');
t('tag pt-PT cai em pt-BR', tagIdioma('pt-PT') === 'pt-BR');
t('tag en-US -> en', tagIdioma('en-US') === 'en');
t('tag es-MX -> es', tagIdioma('es-MX') === 'es');
['ja', 'fr', '', null, undefined, 'xx'].forEach((v) => {
  t(`tag ${JSON.stringify(v)} cai no padrão`, tagIdioma(v) === IDIOMA_PADRAO);
});

// 9) Idioma NÃO RECONHECIDO continua sem diretriz, e comIdioma devolve o prompt
//    byte a byte. Não é detalhe: "não sei qual é" não pode virar "é português"
//    por omissão, senão a normalizaIdioma (que separa as duas coisas de
//    propósito) perde a serventia.
//    MUDANÇA 08/09/2026: até aqui o pt-BR TAMBÉM devolvia null, pelo cache. O
//    buraco disso era en/es mandarem "responda na língua em que a pessoa
//    escreveu" e o pt-BR não mandar nada, então conta em português com usuário
//    falando inglês ficava por conta da sorte do modelo. Marcos mandou fechar.
const PROMPT = 'Você é X.\nEstilo: pt-BR, direto.';
['ja', 'fr', 'de', 'xx', '', '   ', null, undefined, 0, {}].forEach((v) => {
  t(`idioma não atendido ${JSON.stringify(v)} não gera diretriz`, instrucaoDeIdioma(v) === null);
});
t('comIdioma sem idioma devolve o prompt IDÊNTICO', comIdioma(PROMPT, null) === PROMPT);
t('comIdioma em língua não atendida devolve o prompt IDÊNTICO', comIdioma(PROMPT, 'ja') === PROMPT);

// 9b) pt-BR tem diretriz, e ela é a MESMA de 'pt' e 'pt-PT': variante regional
//     não pode gerar prefixo diferente, senão o cache quebra por causa do header
//     do navegador de cada um.
t('pt-BR tem diretriz', typeof instrucaoDeIdioma('pt-BR') === 'string');
t('pt e pt-PT usam a mesma diretriz de pt-BR',
  instrucaoDeIdioma('pt') === instrucaoDeIdioma('pt-BR') && instrucaoDeIdioma('pt-PT') === instrucaoDeIdioma('pt-BR'));
t('diretriz de pt-BR está em português', instrucaoDeIdioma('pt-BR').startsWith('IDIOMA:'));
// A regra que motivou a mudança: espelhar a língua de QUEM ESCREVE.
t('pt-BR manda espelhar a língua do usuário', /responda na língua que ele usou/i.test(instrucaoDeIdioma('pt-BR')));
// E o contrapeso: texto colado (e-mail, documento) não é troca de língua, senão
// mandar ler um e-mail em inglês viraria a conversa inteira pro inglês.
t('pt-BR ressalva o texto colado', /NÃO conta como troca de língua/.test(instrucaoDeIdioma('pt-BR')));
// Custo por conversa: cada byte daqui entra em TODO prompt em português.
t('diretriz de pt-BR é curta', instrucaoDeIdioma('pt-BR').length < 700);
t('pt-BR sem ${} solto', !instrucaoDeIdioma('pt-BR').includes('${'));
t('pt-BR anexa no fim, preservando o prompt',
  comIdioma(PROMPT, 'pt-BR') === `${PROMPT}\n\n${instrucaoDeIdioma('pt-BR')}`);

// 10) en e es têm diretriz, e ela é ANEXADA no fim sem tocar no prompt original.
for (const l of ['en', 'es']) {
  const d = instrucaoDeIdioma(l);
  t(`${l} tem diretriz`, typeof d === 'string' && d.length > 100);
  t(`${l} anexa no fim, preservando o prompt`, comIdioma(PROMPT, l) === `${PROMPT}\n\n${d}`);
  // Interpolação não resolvida vira texto literal no prompt do modelo: barra.
  t(`${l} sem \${} solto`, !d.includes('${'));
  // A cláusula de override é o que resolve a contradição com os "em pt-BR" que
  // continuam espalhados pelo prompt. Sem ela o modelo oscila entre as línguas.
  t(`${l} diz que sobrepõe as outras instruções`, /overrid|prioridad/i.test(d));
  t(`${l} manda ignorar o "em pt-BR"`, d.includes('em pt-BR'));
  // Argumento de tool que o usuário lê (lembrete, sugestão, nota) também conta.
  t(`${l} cobre texto dentro de argumento de tool`, /tool|herramienta/i.test(d));
}
// Variantes regionais recebem a MESMA diretriz da língua base.
t('en-GB usa a diretriz de en', instrucaoDeIdioma('en-GB') === instrucaoDeIdioma('en'));
t('es-419 usa a diretriz de es', instrucaoDeIdioma('es-419') === instrucaoDeIdioma('es'));
t('en e es têm diretrizes diferentes', instrucaoDeIdioma('en') !== instrucaoDeIdioma('es'));
// Escrita na própria língua de destino: instrução em inglês puxa saída em inglês
// muito melhor do que "responda em inglês" escrito em português.
t('diretriz de en está em inglês', instrucaoDeIdioma('en').startsWith('LANGUAGE'));
t('diretriz de es está em espanhol', instrucaoDeIdioma('es').startsWith('IDIOMA'));
// Todo idioma atendido além do padrão precisa de diretriz. Se alguém puser um
// idioma novo em IDIOMAS_OK e esquecer o texto, o teste avisa aqui.
IDIOMAS_OK.filter((l) => l !== IDIOMA_PADRAO).forEach((l) => {
  t(`${l} (de IDIOMAS_OK) tem diretriz escrita`, !!instrucaoDeIdioma(l));
});

// 11) Detector de deriva de idioma. É heurística e só observa, mas as bordas
//     precisam estar travadas: nunca pode rodar em pt-BR (português é o
//     esperado ali) e nunca pode explodir com entrada porcaria, porque ele roda
//     no caminho de resposta do turno.
const PT_LONGO = 'Pronto, já anotei aqui na sua memória que você não gosta de reunião antes das dez da manhã, e também que a sua irmã faz aniversário em março.';
const EN_LONGO = "Done, I noted in your memory that you don't like meetings before ten in the morning, and also that your sister has a birthday in March.";
const ES_LONGO = 'Listo, ya anoté en tu memoria que no te gustan las reuniones antes de las diez de la mañana, y también que tu hermana cumple años en marzo.';

// Em pt-BR o detector tem que ficar CALADO, sempre.
t('pt-BR nunca gera medição', derivaDeIdioma(PT_LONGO, 'pt-BR') === null);
t('pt-PT também não', derivaDeIdioma(PT_LONGO, 'pt-PT') === null);
t('idioma não atendido não gera medição', derivaDeIdioma(PT_LONGO, 'ja') === null);
t('sem idioma não gera medição', derivaDeIdioma(PT_LONGO, null) === null);

// Entrada inútil não vira score inventado.
[null, undefined, '', '   ', 'ok', 'sim', 0, {}, []].forEach((v) => {
  t(`entrada ${JSON.stringify(v)} não gera score`, derivaDeIdioma(v, 'en') === null);
});

// O que ele existe pra pegar: português saindo pra quem pediu en/es.
for (const l of ['en', 'es']) {
  const d = derivaDeIdioma(PT_LONGO, l);
  t(`${l}: português é flagrado`, d !== null && d.suspeita === true);
  t(`${l}: devolve contagem coerente`, d.palavras > 8 && d.marcas > 0 && d.score > 0);
  t(`${l}: reporta o idioma esperado`, d.idioma === l);
}

// E o que ele NÃO pode acusar: a resposta certa na língua certa.
const dEn = derivaDeIdioma(EN_LONGO, 'en');
t('en limpo não é acusado', dEn !== null && dEn.suspeita === false);
// pt vs es é o caso difícil (vocabulário quase todo compartilhado): se o
// detector acusar espanhol correto, o log viraria ruído e ninguém olharia.
const dEs = derivaDeIdioma(ES_LONGO, 'es');
t('es limpo não é acusado', dEs !== null && dEs.suspeita === false);
t('português pontua MAIS que espanhol', derivaDeIdioma(PT_LONGO, 'es').score > dEs.score);

// 12) Lembrete por turno (30/09/2026, DeepSeek respondeu em chinês a uma conta
//     pt-BR numa thread longa): cada idioma atendido tem o seu, escrito na
//     própria língua, curto (vai em toda mensagem), e língua não atendida não
//     ganha lembrete nenhum.
t('lembrete pt-BR em português', lembreteDeIdioma('pt-BR').includes('português do Brasil'));
t('lembrete en em inglês', lembreteDeIdioma('en').includes('reply in English'));
t('lembrete es em espanhol', lembreteDeIdioma('es').includes('responde en español'));
t('variante regional usa o mesmo lembrete', lembreteDeIdioma('pt') === lembreteDeIdioma('pt-BR') && lembreteDeIdioma('en-GB') === lembreteDeIdioma('en'));
for (const l of IDIOMAS_OK) t(`lembrete ${l} é curto`, lembreteDeIdioma(l).length > 0 && lembreteDeIdioma(l).length < 250);
for (const v of ['ja', 'zh', '', null, undefined]) t(`sem lembrete para ${JSON.stringify(v)}`, lembreteDeIdioma(v) === '');

// 13) Freio de ideograma: as derivas reais de prod são pegas, e o japonês que o
//     dono pede de propósito (sempre com kana) ou o pedido explícito de chinês
//     passam. Quem mexer no corte vê aqui se começou a traduzir resposta legítima.
const DERIVA_0510 = '两件事：\n\n**Pepecarteira — 现在没打通。** 我尝试访问并返回了“未找到”（404）：网站在线，但我的代理用来记录/查询的接口此刻没有响应。所以现在，我**无法**从那里记录或核实任何内容。';
const DERIVA_3009 = '调整已安排好——今天的两个区块都不会丢，下午的区块避开了 Solar 会议（14:00–16:00）：\n\n- **区块 1**：15:30–17:00 → **16:15–17:45** *（在会议结束后，留出 15 分钟缓冲）*';
const JAPONES_PEDIDO = '**Tarefas diárias**\n- [x] 靴を買いに行く（くつをかいにいく）\n- 言語を勉強して\n- トフの砂を買って\n- オベンの修理を頼む\n- 鶏肉を解凍する';
t('deriva 05/10 é pega', ideogramaAcidental(DERIVA_0510, 'pt-BR', 'pode cancelar esses lembretes')?.idioma === 'pt-BR');
t('deriva 30/09 é pega', !!ideogramaAcidental(DERIVA_3009, 'pt-BR', 'Pode ajustar os blocos das aulas gravadas na agenda'));
t('deriva em conta en é pega', ideogramaAcidental(DERIVA_0510, 'en', 'cancel those reminders')?.idioma === 'en');
t('japonês pedido passa', ideogramaAcidental(JAPONES_PEDIDO, 'pt-BR', 'adiciona na lista') === null);
t('pedido de chinês passa', ideogramaAcidental(DERIVA_0510, 'pt-BR', 'traduz isso pra chinês') === null);
t('dono escrevendo em chinês passa', ideogramaAcidental(DERIVA_0510, 'pt-BR', '你好，请帮我') === null);
t('palavra solta em chinês passa', ideogramaAcidental('O caractere 你好 quer dizer olá; 谢谢 é obrigado.', 'pt-BR', 'como diz olá') === null);
for (const l of IDIOMAS_OK) t(`aviso sem idioma ${l} não tem ideograma`, !!avisoSemIdioma(l) && !/\p{Script=Han}/u.test(avisoSemIdioma(l)));

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
