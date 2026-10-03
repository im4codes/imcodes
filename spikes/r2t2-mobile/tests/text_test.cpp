// Checks the C++ text helpers against outputs produced by the pinned upstream
// Python (tests/gen_text_cases.py -> tests/text_cases.tsv).
#include "r2t2_text.h"

#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {
std::vector<std::string> split(const std::string & s, char sep) {
    std::vector<std::string> out;
    size_t start = 0;
    for (;;) {
        const size_t p = s.find(sep, start);
        out.push_back(s.substr(start, p == std::string::npos ? std::string::npos : p - start));
        if (p == std::string::npos) break;
        start = p + 1;
    }
    return out;
}
} // namespace

int main(int argc, char ** argv) {
    const std::string path = argc > 1 ? argv[1] : "tests/text_cases.tsv";
    std::ifstream in(path, std::ios::binary);
    if (!in) { std::fprintf(stderr, "cannot open %s\n", path.c_str()); return 2; }
    const std::string data((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    int pass = 0, fail = 0;
    for (const std::string & rec : split(data, '\x1e')) {
        const auto f = split(rec, '\x1f');
        if (f.size() != 4) continue;
        const std::string & fn = f[0];
        const std::string & input = f[1];
        const std::string & arg = f[2];
        const std::string & want = f[3];
        std::string got;
        if (fn == "punct") got = r2t2::normalize_punct_by_context(input);
        else if (fn == "hanspace") got = r2t2::remove_spaces_between_han(input);
        else if (fn == "rep") got = r2t2::detect_and_fix_repetitions(input);
        else if (fn == "parse") {
            auto r = r2t2::parse_asr_output(input, arg);
            got = r.first + "\x1d" + r.second;
        }
        if (got == want) {
            ++pass;
        } else {
            ++fail;
            std::fprintf(stderr, "FAIL %s(%s | %s)\n  want=[%s]\n  got =[%s]\n", fn.c_str(), input.c_str(), arg.c_str(),
                         want.c_str(), got.c_str());
        }
    }
    std::printf("text conformance: %d passed, %d failed\n", pass, fail);
    return fail == 0 && pass > 0 ? 0 : 1;
}
