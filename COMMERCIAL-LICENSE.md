# IM.codes Commercial Licensing Guide / 商业授权说明

IM.codes is licensed under the **Business Source License 1.1 (BSL 1.1)** — see [LICENSE](LICENSE) for the authoritative legal text.

IM.codes 采用 **Business Source License 1.1 (BSL 1.1)** 协议发布——具有法律效力的完整条款请见 [LICENSE](LICENSE)。

---

## Summary / 授权概览

Under BSL 1.1, **non-production use, copying, modification, and compliant redistribution** (preserving copyright/license notices and respecting trademark limits) are permitted for **all recipients regardless of organization size** until the Change Date. The size limits and SaaS/hosting exclusions below apply strictly to whether **Production Use** prior to the Change Date is covered by the **Additional Use Grant**.

在 BSL 1.1 生效期间，**非生产环境使用、复制、修改及合规再分发**（保留原版权与协议声明并遵守商标限制）对**任何规模的个人或组织均免费开放**。下述席位、组织总人数门槛及 SaaS/托管限制，仅用于界定在开源转换日（Change Date）之前**生产使用（Production Use）**是否属于「附加使用授权（Additional Use Grant）」的免费范围。

| Use Case / 使用场景 | Free or Commercial / 免费或商用 | Scope & Requirements / 范围与说明 |
| --- | --- | --- |
| **Non-Production Use & Evaluation**<br>非生产环境使用与评估 | **Free**<br>免费 | Permitted for **any** organization size (e.g. a 100-person enterprise running local evaluation, testing, development, or staging) under standard BSL 1.1, together with compliant copying, modification, and redistribution preserving notices and trademark terms.<br>依据 BSL 1.1 标准条款对**任意规模**组织免费开放（例如 100 人企业进行本地评估、测试、开发或预发验证），同样允许在保留版权/协议声明及遵守商标条款的前提下复制、修改与合规再分发。 |
| **Personal Production Use**<br>个人生产使用 | **Free (Permanently)**<br>永久免费 | Permitted under Additional Use Grant §(1) for natural persons on personal devices/servers for personal development, learning, research, or personal self-hosting (not centrally deployed or shared across an organization, and excluding third-party hosting/SaaS/white-label service under §(3)(b)), regardless of employer size.<br>依据附加使用授权第 (1) 条，自然人在个人设备/个人服务器上用于个人开发、学习、研究或个人自托管永久免费（非组织集中部署或跨团队共享，且不用于第 (3)(b) 条所述第三方托管/SaaS/白标商业服务），不受所在雇主规模限制。 |
| **Small-Team Internal Production Use**<br>小型团队内部生产使用 | **Free**<br>免费 | Permitted under Additional Use Grant §(2) for internal organizational Production Use only when **BOTH** aggregated limits hold across the legal entity, all affiliates/subsidiaries, and all deployed instances: total distinct active users/seats **<= 5** **AND** total organization headcount **<= 50** (employees + full-time contractors).<br>依据附加使用授权第 (2) 条，仅当按法律实体及其所有关联公司/子公司并跨所有部署实例**合并计算**同时满足：独立活跃用户/席位总数 **<= 5 人** **且** 组织总人数 **<= 50 人**（含员工与全职外包）时，内部生产使用免费。 |
| **Internal Production Above Thresholds**<br>超阈值组织内部生产使用 | **Outside Additional Grant -> Commercial License**<br>超出附加授权范围（需商业授权） | Prior to the Change Date, internal Production Use exceeding either threshold when aggregated across the legal entity, affiliates, and all instances (e.g. **6/50**, **5/51**, or a **100-person** company in production) is **outside the Additional Use Grant** and requires a commercial license.<br>在转换日前，按法律实体、关联实体及全部实例合计超过任一阈值（如 **6 席位/50 人**、**5 席位/51 人**或 **100 人企业生产部署**）均**不属于**附加生产使用授权范围，需购买商业授权。 |
| **Commercial Hosting / Multi-Tenant SaaS / White-Label Production**<br>商业托管 / 多租户 SaaS / 白标生产服务 | **Outside Additional Grant -> Commercial License**<br>超出附加授权范围（需商业授权） | Prior to the Change Date, Production Use to provide hosted services, managed services, multi-tenant SaaS, or commercial white-label/rebranded service or resale to third parties is **outside the Additional Use Grant regardless of headcount or user count (even 1 person)**.<br>在转换日前，将本软件用于向第三方提供商业托管、管理服务、多租户 SaaS 或白标/商业转售的生产使用，**无论团队人数与席位多少（即使只有 1 人）均不属于**附加生产使用授权范围，必须取得商业授权。 |

**Change Date & Open-Source Conversion / 开源转换条款：**
- Under BSL 1.1, this release (**2026-11-26**) converts automatically to the **Apache License, Version 2.0** on **2030-11-26** (4 years from public release; each subsequent version converts 4 years from its first public release date).
- 根据 BSL 1.1，本版本（**2026-11-26**）将在 **2030-11-26**（公开发布满 4 年后）自动转换为 **Apache License 2.0**（后续版本均在其首次公开发布起 4 年后转换）。

---

## FAQ / 常见问题

### 1. How are seats and organization headcount counted? / 如何计算席位与组织总人数？
- **Active users / seats (<= 5):** Total distinct individuals using IM.codes (connecting daemons, web/mobile clients, or operating controlled nodes) **aggregated across all deployed instances** of the organization and its affiliates (not limited to production instances alone — e.g., 5 production users plus 1 additional distinct active test user on another instance equals **6 total active users**, exceeding the 5-seat limit if the organization makes Production Use). Purely non-production use with no organizational Production Use remains free under standard BSL 1.1 regardless of user count.
- **Organization headcount (<= 50):** Total employees and full-time contractors combined **aggregated across the entire legal entity and all of its affiliates and subsidiaries**, **not** merely the size of a single engineering team or department.
- **活跃用户/席位（<= 5）：** 组织及其关联实体在**所有已部署实例中合计**实际使用 IM.codes（连接守护进程、Web/移动端或操作受控节点）的独立人员总数（不区分所在实例是否为生产环境——例如：某 50 人组织在生产环境有 5 名活跃用户、在另一测试实例另有 1 名不同的活跃测试用户，则全组织合计活跃用户为 **6 人**，若该组织继续进行生产使用，已超出 5 席位上限，需购买商业授权；若全组织完全仅进行纯非生产使用，则无论人数多少均依据标准 BSL 1.1 免费）。
- **组织总人数（<= 50）：** **整个法律实体及其所有关联公司/子公司合计**的在职员工与全职外包人员总和，**而非**单个研发小组、部门或单个实例的人数。

### 2. Can a 100-person company evaluate IM.codes locally without a commercial license? / 100 人的企业可以不买商业授权在本地评估和测试吗？
- **Yes.** Non-production use (such as local evaluation, testing, development, or staging) is granted directly under the standard BSL 1.1 terms to everyone regardless of organization size. A commercial license is only required prior to the Change Date when a >50-headcount (or >5-seat) organization uses IM.codes in **production**.
- **可以。** 根据 BSL 1.1 标准条款，任何规模的组织都免费拥有**非生产使用**权利（例如 100 人企业进行本地评估、测试、开发或内部非生产验证）。只有当超过 50 人或超过 5 席位的组织将其投入**生产使用**时，才需要在转换日前购买商业授权。

### 3. I work at a company with > 50 employees — can I still use IM.codes for free on my own? / 我在超过 50 人的公司工作，还能个人免费使用吗？
- **Yes.** If you are a natural person deploying and using IM.codes strictly for personal projects, learning, research, or personal self-hosting on your own devices/servers — and it is not centrally deployed, mandated, or shared across your employer/organization — personal Production Use is permanently free under §(1) of the Additional Use Grant.
- **可以。** 只要您作为自然人仅在个人设备/个人服务器上用于个人开发、学习、研究或个人自托管（不由公司集中部署、采购分发或跨组织成员共享），即属于附加使用授权第 (1) 条的个人免费生产使用范围，不受所在雇主规模限制。

### 4. What about versions released before BSL 1.1? / 在切换 BSL 1.1 之前发布的历史版本适用什么协议？
- Prior versions of IM.codes released under the MIT License remain licensed under the MIT License for those specific prior commits. Business Source License 1.1 governs this release and subsequent releases until each version's Change Date.
- 此前以 MIT 协议发布的特定历史 commit/版本，仍按原 MIT 协议适用；自本版本及之后的发布适用 Business Source License 1.1，直到对应版本满 4 年转为 Apache 2.0。

### 5. How do I obtain a commercial license? / 如何获取商业授权？
Contact **support@im.codes** with your organization name, estimated active seats, total headcount across entity & affiliates, and deployment model (internal production vs. hosted/multi-tenant SaaS/white-label).

请发送邮件至 **support@im.codes**，注明企业/组织（含关联公司）名称、预计生产使用席位数、组织总人数及部署方式（内部生产部署 / 商业托管或 SaaS / 白标服务）。
