const MessageParser = require('./message_parser');

test("Returns null to messages without links.", () => {
  const input = "How can I help you vote?";
  const expected = null;
  expect(MessageParser.processMessageText(input)).toBe(null);
});

test("Removes carrot brackets from link in message.", () => {
  const input = "You can check your registration here: <https://registration.elections.myflorida.com/CheckVoterStatus>";
  const expected = "You can check your registration here: https://registration.elections.myflorida.com/CheckVoterStatus";
  expect(MessageParser.processMessageText(input)).toBe(expected);
});

test("Removes carrot brackets from multiple links in message and dedupes.", () => {
  const input = "You can check your registration here: <https://registration.elections.myflorida.com/CheckVoterStatus> or here: <https://vt.ncsbe.gov/RegLkup/>";
  const expected = "You can check your registration here: https://registration.elections.myflorida.com/CheckVoterStatus or here: https://vt.ncsbe.gov/RegLkup/";
  expect(MessageParser.processMessageText(input)).toBe(expected);
});

test("Dedupes double link in message.", () => {
  const input = "You can check your registration here: <https://registration.elections.myflorida.com/CheckVoterStatus|https://registration.elections.myflorida.com/CheckVoterStatus>";
  const expected = "You can check your registration here: https://registration.elections.myflorida.com/CheckVoterStatus";
  expect(MessageParser.processMessageText(input)).toBe(expected);
});

test("Dedupes multiple double links in message.", () => {
  const input = "You can check your registration here: <https://registration.elections.myflorida.com/CheckVoterStatus|https://registration.elections.myflorida.com/CheckVoterStatus> or here: <https://vt.ncsbe.gov/RegLkup/|https://vt.ncsbe.gov/RegLkup/>";
  const expected = "You can check your registration here: https://registration.elections.myflorida.com/CheckVoterStatus or here: https://vt.ncsbe.gov/RegLkup/";
  expect(MessageParser.processMessageText(input)).toBe(expected);
});