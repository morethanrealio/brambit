// ── Mídia enviada SEM texto ────────────────────────────────────────────────
// Quando a pessoa manda só uma foto ou só um arquivo, sem escrever nada junto,
// o turno ainda precisa de algum texto pra virar mensagem. O que existia em
// cada canal era uma ORDEM inventada no nome dela: "Extraia e me explique as
// informações desta imagem" (web e cockpit), "Veja as imagens que enviei e me
// explique" (WhatsApp e Telegram), "Leia o documento que enviei e me explique".
// O assistente obedecia ao pé da letra, porque para ele aquilo era o pedido do
// dono.
//
// Em 09/09/2026 isso despejou no chat a CNH inteira do dono (nome, CPF, número
// de registro) num turno em que ele só tinha mandado o documento pra abrir a
// Conta Brambs. Ninguém pediu leitura em voz alta: o pedido era "toma o
// documento". O bug é inventar pedido no nome do usuário, não a leitura da
// imagem.
//
// Então o texto passa a DESCREVER o que aconteceu, em vez de mandar despejar, e
// deixa a reação por conta do contexto da conversa. Nenhuma capacidade é
// perdida: neste turno o modelo VÊ a imagem, a leitura completa dela continua
// sendo gerada no recebimento e guardada no histórico (imageHistoryMarkers, em
// server.mjs), e o texto do PDF continua indo pro modelo. Quem manda a foto e
// pergunta "o que é isso?" recebe a leitura inteira como sempre, porque aí
// existe pedido de verdade.
export function notaMidiaSemTexto({ images = 0, files = 0 } = {}) {
  const oque = images && files
    ? 'uma foto e um arquivo'
    : images > 1 ? `${images} fotos`
      : images ? 'uma foto'
        : files > 1 ? `${files} arquivos`
          : 'um arquivo';
  return `[Sem texto: a pessoa enviou ${oque} e não escreveu nada junto. Isso NÃO é um pedido de leitura. Reaja ao que ela mandou dentro do contexto da conversa: se é o arquivo que você acabou de pedir, siga direto o próximo passo; se não estiver claro o que ela quer, pergunte em uma frase. NÃO transcreva nem liste no chat o conteúdo do que ela enviou (dados de documento, CPF, números, texto da tela) a menos que ela peça: você está vendo o arquivo e pode usá-lo sem repetir de volta pra quem já sabe o que mandou.]`;
}
