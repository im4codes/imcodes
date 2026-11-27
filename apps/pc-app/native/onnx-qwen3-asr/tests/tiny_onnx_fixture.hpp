#pragma once

#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace imcodes::qwen3::test_onnx {

namespace detail {

inline void write_varint(std::vector<uint8_t>& out, uint64_t v) {
  while (v >= 0x80u) {
    out.push_back(static_cast<uint8_t>((v & 0x7Fu) | 0x80u));
    v >>= 7;
  }
  out.push_back(static_cast<uint8_t>(v));
}

inline void write_key(std::vector<uint8_t>& out, uint32_t field, uint32_t wire_type) {
  write_varint(out, (static_cast<uint64_t>(field) << 3) | wire_type);
}

inline void write_bytes_field(std::vector<uint8_t>& out, uint32_t field, const void* data, size_t len) {
  write_key(out, field, 2);
  write_varint(out, static_cast<uint64_t>(len));
  const auto* p = static_cast<const uint8_t*>(data);
  out.insert(out.end(), p, p + len);
}

inline void write_str_field(std::vector<uint8_t>& out, uint32_t field, const std::string& s) {
  write_bytes_field(out, field, s.data(), s.size());
}

inline void write_i64_field(std::vector<uint8_t>& out, uint32_t field, int64_t v) {
  write_key(out, field, 0);
  write_varint(out, static_cast<uint64_t>(v));
}

inline std::vector<uint8_t> make_value_info(
    const std::string& name,
    int32_t elem_type,
    const std::vector<int64_t>& dims) {
  std::vector<uint8_t> shape;
  for (int64_t d : dims) {
    std::vector<uint8_t> dim_msg;
    if (d > 0) {
      write_i64_field(dim_msg, 1, d);
    } else {
      write_str_field(dim_msg, 2, "dyn");
    }
    write_bytes_field(shape, 1, dim_msg.data(), dim_msg.size());
  }
  std::vector<uint8_t> tensor_t;
  write_i64_field(tensor_t, 1, elem_type);
  write_bytes_field(tensor_t, 2, shape.data(), shape.size());

  std::vector<uint8_t> type_proto;
  write_bytes_field(type_proto, 1, tensor_t.data(), tensor_t.size());

  std::vector<uint8_t> vi;
  write_str_field(vi, 1, name);
  write_bytes_field(vi, 2, type_proto.data(), type_proto.size());
  return vi;
}

inline std::vector<uint8_t> make_tensor_proto(
    const std::string& name,
    int32_t data_type,
    const std::vector<int64_t>& dims,
    const void* raw_data,
    size_t raw_bytes) {
  std::vector<uint8_t> tp;
  for (int64_t d : dims) {
    write_i64_field(tp, 1, d);
  }
  write_i64_field(tp, 2, data_type);
  if (!name.empty()) {
    write_str_field(tp, 8, name);
  }
  write_bytes_field(tp, 9, raw_data, raw_bytes);
  return tp;
}

inline std::vector<uint8_t> make_attr_tensor(const std::string& name, const std::vector<uint8_t>& tensor) {
  std::vector<uint8_t> a;
  write_str_field(a, 1, name);
  write_bytes_field(a, 5, tensor.data(), tensor.size());
  write_i64_field(a, 20, 4);  // TENSOR
  return a;
}

inline std::vector<uint8_t> make_attr_int(const std::string& name, int64_t v) {
  std::vector<uint8_t> a;
  write_str_field(a, 1, name);
  write_i64_field(a, 3, v);
  write_i64_field(a, 20, 2);  // INT
  return a;
}

inline std::vector<uint8_t> make_attr_ints(const std::string& name, const std::vector<int64_t>& vs) {
  std::vector<uint8_t> a;
  write_str_field(a, 1, name);
  for (int64_t v : vs) write_i64_field(a, 8, v);  // repeated int64 ints = 8
  write_i64_field(a, 20, 7);                      // INTS
  return a;
}

inline std::vector<uint8_t> make_node(
    const std::string& op_type,
    const std::vector<std::string>& inputs,
    const std::vector<std::string>& outputs,
    const std::string& name,
    const std::vector<std::vector<uint8_t>>& attrs = {}) {
  std::vector<uint8_t> node;
  for (const auto& s : inputs) write_str_field(node, 1, s);
  for (const auto& s : outputs) write_str_field(node, 2, s);
  write_str_field(node, 3, name);
  write_str_field(node, 4, op_type);
  for (const auto& a : attrs) write_bytes_field(node, 5, a.data(), a.size());
  return node;
}

inline bool write_model(
    const std::filesystem::path& path,
    const std::vector<std::vector<uint8_t>>& nodes,
    const std::vector<std::vector<uint8_t>>& initializers,
    const std::vector<std::vector<uint8_t>>& inputs,
    const std::vector<std::vector<uint8_t>>& outputs) {
  std::vector<uint8_t> graph;
  for (const auto& n : nodes) write_bytes_field(graph, 1, n.data(), n.size());
  write_str_field(graph, 2, "tiny_test_graph");
  for (const auto& init : initializers) write_bytes_field(graph, 5, init.data(), init.size());
  for (const auto& in : inputs) write_bytes_field(graph, 11, in.data(), in.size());
  for (const auto& out : outputs) write_bytes_field(graph, 12, out.data(), out.size());

  std::vector<uint8_t> opset;
  write_str_field(opset, 1, "");
  write_i64_field(opset, 2, 13);

  std::vector<uint8_t> model;
  write_i64_field(model, 1, 8);  // ir_version = 8
  write_bytes_field(model, 7, graph.data(), graph.size());
  write_bytes_field(model, 8, opset.data(), opset.size());

  std::ofstream ofs(path, std::ios::binary);
  if (!ofs.is_open()) return false;
  ofs.write(reinterpret_cast<const char*>(model.data()), static_cast<std::streamsize>(model.size()));
  return ofs.good();
}

}  // namespace detail

constexpr int32_t kOnnxFloat = 1;
constexpr int32_t kOnnxInt64 = 7;
constexpr int32_t kOnnxBool = 9;

inline bool write_const_conv_frontend(const std::filesystem::path& path, int64_t frames, int64_t hidden) {
  std::vector<float> vals(static_cast<size_t>(frames * hidden), 1.0f);
  auto const_t = detail::make_tensor_proto(
      "conv_const", kOnnxFloat, {1, frames, hidden}, vals.data(), vals.size() * sizeof(float));
  auto node = detail::make_node(
      "Constant", {}, {"conv_output"}, "c0", {detail::make_attr_tensor("value", const_t)});
  return detail::write_model(
      path,
      {node},
      {},
      {detail::make_value_info("input_features", kOnnxFloat, {1, -1, 128})},
      {detail::make_value_info("conv_output", kOnnxFloat, {1, frames, hidden})});
}

inline bool write_const_encoder(
    const std::filesystem::path& path,
    const std::vector<float>& frame_major_data,
    int64_t frames,
    int64_t hidden) {
  auto const_t = detail::make_tensor_proto(
      "enc_const", kOnnxFloat, {1, frames, hidden},
      frame_major_data.data(), frame_major_data.size() * sizeof(float));
  auto node = detail::make_node(
      "Constant", {}, {"audio_features"}, "e0", {detail::make_attr_tensor("value", const_t)});
  return detail::write_model(
      path,
      {node},
      {},
      {detail::make_value_info("input_features", kOnnxFloat, {1, -1, hidden}),
       detail::make_value_info("feature_attention_mask", kOnnxBool, {1, -1})},
      {detail::make_value_info("audio_features", kOnnxFloat, {1, frames, hidden})});
}

/**
 * Tiny 1-layer decoder fixture using real ONNX nodes:
 *  - `logits = Gather(logit_table [vocab, vocab], input_ids)` -> shape `[1, T, vocab]`
 *  - `key_delta_0 = Unsqueeze(Expand(zeros [1, 1, heads, head_dim], ...), ...)` via Tile / Concat!
 * Using `Shape(input_ids)[1]` to Expand `[1, 1, heads, head_dim]` -> `[1, T, heads, head_dim]`!
 */
inline bool write_tiny_decoder(
    const std::filesystem::path& path,
    const std::vector<float>& logit_table_row_major,
    int64_t vocab_size,
    int64_t audio_hidden,
    int64_t kv_heads,
    int64_t head_dim,
    int64_t kv_dim1_fixed_or_neg1) {
  auto tbl = detail::make_tensor_proto(
      "logit_table", kOnnxFloat, {vocab_size, vocab_size},
      logit_table_row_major.data(), logit_table_row_major.size() * sizeof(float));

  std::vector<float> zero_kv(static_cast<size_t>(kv_heads * head_dim), 0.0f);
  auto kv_tmpl = detail::make_tensor_proto(
      "kv_tmpl", kOnnxFloat, {1, 1, kv_heads, head_dim},
      zero_kv.data(), zero_kv.size() * sizeof(float));

  int64_t c_one_i64 = 1;
  auto init_one = detail::make_tensor_proto("c_one", kOnnxInt64, {}, &c_one_i64, sizeof(int64_t));
  auto init_one_1d = detail::make_tensor_proto("c_one_1d", kOnnxInt64, {1}, &c_one_i64, sizeof(int64_t));
  int64_t kv_tail_dims[2] = {kv_heads, head_dim};
  auto init_kv_tail = detail::make_tensor_proto("c_kv_tail", kOnnxInt64, {2}, kv_tail_dims, sizeof(kv_tail_dims));

  // Build logits via Gather(logit_table, input_ids)
  auto n_logits = detail::make_node(
      "Gather", {"logit_table", "input_ids"}, {"logits"}, "g_logits", {detail::make_attr_int("axis", 0)});

  // Compute T = Shape(input_ids)[1], then Expand(kv_tmpl, [1, T, kv_heads, head_dim])
  auto n_shape = detail::make_node("Shape", {"input_ids"}, {"ids_shape"}, "s_ids");
  auto n_t = detail::make_node("Gather", {"ids_shape", "c_one"}, {"t_scalar"}, "g_t", {detail::make_attr_int("axis", 0)});
  int64_t ax0 = 0;
  auto init_ax0 = detail::make_tensor_proto("c_ax0", kOnnxInt64, {1}, &ax0, sizeof(int64_t));
  auto n_t1d = detail::make_node("Unsqueeze", {"t_scalar", "c_ax0"}, {"t_1d"}, "u_t");
  auto n_kv_shape = detail::make_node(
      "Concat", {"c_one_1d", "t_1d", "c_kv_tail"}, {"kv_delta_shape"}, "cat_kv", {detail::make_attr_int("axis", 0)});
  auto n_kd = detail::make_node("Expand", {"kv_tmpl", "kv_delta_shape"}, {"key_delta_0"}, "exp_k");
  auto n_vd = detail::make_node("Identity", {"key_delta_0"}, {"value_delta_0"}, "id_v");

  return detail::write_model(
      path,
      {n_logits, n_shape, n_t, n_t1d, n_kv_shape, n_kd, n_vd},
      {tbl, kv_tmpl, init_one, init_one_1d, init_kv_tail, init_ax0},
      {
          detail::make_value_info("input_ids", kOnnxInt64, {1, -1}),
          detail::make_value_info("audio_features", kOnnxFloat, {1, -1, audio_hidden}),
          detail::make_value_info("attention_mask", kOnnxInt64, {1, -1}),
          detail::make_value_info("cache_position", kOnnxInt64, {-1}),
          detail::make_value_info("cache_key_0", kOnnxFloat, {1, kv_dim1_fixed_or_neg1, kv_heads, head_dim}),
          detail::make_value_info("cache_value_0", kOnnxFloat, {1, kv_dim1_fixed_or_neg1, kv_heads, head_dim}),
      },
      {
          detail::make_value_info("logits", kOnnxFloat, {1, -1, vocab_size}),
          detail::make_value_info("key_delta_0", kOnnxFloat, {1, -1, kv_heads, head_dim}),
          detail::make_value_info("value_delta_0", kOnnxFloat, {1, -1, kv_heads, head_dim}),
      });
}

inline bool write_minimal_tokenizer_files(const std::filesystem::path& tok_dir) {
  std::filesystem::create_directories(tok_dir);
  {
    std::ofstream v(tok_dir / "vocab.json");
    if (!v.is_open()) return false;
    v << "{\n"
      << "  \"a\": 0,\n"
      << "  \"b\": 1,\n"
      << "  \"\\u010a\": 8,\n"
      << "  \"system\": 5,\n"
      << "  \"user\": 6,\n"
      << "  \"assistant\": 7,\n"
      << "  \"hello\": 12,\n"
      << "  \"language\": 13,\n"
      << "  \"\\u0120English\": 14,\n"
      << "  \"\\u00e4\\u00b8\": 15,\n"
      << "  \"\\u0123\": 16,\n"
      << "  \"world\": 17\n"
      << "}\n";
  }
  {
    std::ofstream m(tok_dir / "merges.txt");
    if (!m.is_open()) return false;
    m << "#version: 0.2\n";
  }
  {
    std::ofstream c(tok_dir / "tokenizer_config.json");
    if (!c.is_open()) return false;
    c << "{\n"
      << "  \"eos_token\": \"<|im_end|>\",\n"
      << "  \"pad_token\": \"<|endoftext|>\",\n"
      << "  \"added_tokens_decoder\": {\n"
      << "    \"2\": {\"content\": \"<|endoftext|>\"},\n"
      << "    \"3\": {\"content\": \"<|im_end|>\"},\n"
      << "    \"4\": {\"content\": \"<asr_text>\"},\n"
      << "    \"9\": {\"content\": \"<|im_start|>\"},\n"
      << "    \"10\": {\"content\": \"<|audio_start|>\"},\n"
      << "    \"11\": {\"content\": \"<|audio_end|>\"},\n"
      << "    \"18\": {\"content\": \"<|audio_pad|>\"}\n"
      << "  }\n"
      << "}\n";
  }
  return true;
}

}  // namespace imcodes::qwen3::test_onnx
