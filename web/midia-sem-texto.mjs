// ── Media sent WITHOUT text ────────────────────────────────────────────────
// When the person sends just a photo or just a file, writing nothing with it,
// the turn still needs some text to become a message. What each channel had
// was an ORDER made up in their name: "Extract and explain the information in
// this image" (web and cockpit), "Look at the images I sent and explain"
// (WhatsApp and Telegram), "Read the document I sent and explain".
// The assistant obeyed to the letter, because to it that was the owner's
// request.
//
// On 09/09/2026 this dumped the owner's whole driver's license (name, tax ID,
// registration number) into the chat in a turn where they had only sent the
// document to open a payment account. Nobody asked for it read aloud: the
// request was "here's the document". The bug is inventing a request in the
// user's name, not reading the image.
//
// So the text now DESCRIBES what happened instead of asking for a dump, and
// leaves the reaction to the conversation's context. No capability is lost:
// in this turn the model SEES the image, its full reading is still generated
// on receipt and kept in history (imageHistoryMarkers, in server.mjs), and the
// PDF text still goes to the model. Whoever sends the photo and asks "what is
// this?" gets the full reading as always, because then there's a real request.
export function notaMidiaSemTexto({ images = 0, files = 0 } = {}) {
  const oque = images && files
    ? 'uma foto e um arquivo'
    : images > 1 ? `${images} fotos`
      : images ? 'uma foto'
        : files > 1 ? `${files} arquivos`
          : 'um arquivo';
  return `[Sem texto: a pessoa enviou ${oque} e não escreveu nada junto. Isso NÃO é um pedido de leitura. Reaja ao que ela mandou dentro do contexto da conversa: se é o arquivo que você acabou de pedir, siga direto o próximo passo; se não estiver claro o que ela quer, pergunte em uma frase. NÃO transcreva nem liste no chat o conteúdo do que ela enviou (dados de documento, CPF, números, texto da tela) a menos que ela peça: você está vendo o arquivo e pode usá-lo sem repetir de volta pra quem já sabe o que mandou.]`;
}
