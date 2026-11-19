/**
 * Whether text typed in the image mode reads as a question rather than a picture
 * description. The image mode sends the text to the image model as it is, so a
 * question there is drawn instead of answered; the composer says so, and the
 * user decides. Only a hint: nothing is stopped, so a guess that misses costs
 * a line of text, not a send.
 */
export function looksLikeQuestion(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/[?？]\s*$/.test(value)) return true;
  if (/(吗|呢)[\s。.!！~～]*$/.test(value)) return true;
  if (/^(为什么|为啥|怎么|怎样|如何|什么是|是什么|请问|哪个|哪些|哪里|是否|解释一下|介绍一下)/.test(value)) return true;
  return /^(what|why|how|when|where|who|which|explain|tell me)\b/i.test(value);
}
