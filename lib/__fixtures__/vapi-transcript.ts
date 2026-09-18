/**
 * A real Vapi end-of-call transcript, captured from production and anonymised.
 *
 * lib/safety.ts rests entirely on this speaker-label format and nothing asserted it.
 * If Vapi changes `User:`, parentTurnsOnly silently falls back to scanning Rosie's own
 * words — reinstating the daily false alerts watch items were built to kill — AND
 * hasParentResponse returns false for every call, appending "Parent didn't respond" as
 * a concern to every check-in. One format change breaks the product in both directions
 * at once, with no error anywhere.
 */
export const REAL_VAPI_TRANSCRIPT = "AI: Hi Margaret, it's Rosie calling for your check-in. How are you feeling today?\nUser: I'm feeling good. How are you? What's up?\nAI: I'm glad to hear you're feeling good. I'm here to check in on you and make sure everything's going smoothly. Have you taken your medications today? Specifically M1, half pill, the blue one, and M2, two, the black ones.\nUser: Oh, I can't find. The M1. Which color is it?\nAI: The M1 is the blue one. If you can't find it, maybe take a moment to look for it. It's important to stay on track with your medications.\nUser: Oh, I think I found it. Yeah.\nAI: Great. I'm glad you found it. There are no appointments scheduled for today. Is there anything you need or anything you'd like your family to know?\nUser: I'm not feeling good.\nAI: I'm sorry to hear that you're not feeling well. Can you tell me a bit more about how you're feeling? If it's something urgent, please hang up and call 911. I can also let your family know.\nUser: No, I'm just not feeling well. I'm having a headache.\nAI: I'm sorry to hear about your headache. Make sure to rest and stay hydrated. If it gets worse or you need assistance, please reach out to someone nearby. Or let your family know. So today you took your medications, and there are no appointments scheduled. Is there. Anything else I should note or change?\nUser: You forgot that I had headache. Which I generally don't.";
